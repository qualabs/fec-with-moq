// The publisher's object production against the Python publisher's bytes: web/fec-decoder's
// media-vectors.json (scripts/fec_media_vectors.py, from media.py's MediaBlockSchedule and moq.py's
// rung_slices / pack_repair) holds real AV1 frames, their LOC objects, the src datagrams and the
// repair datagrams of three 0.15 rungs.
//
//   node --test test/producer.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodePropertyBlock } from "@openmoq/transport";
import { locProperties, packLocObject, unpackLocObject, LOC_PROP_TIMESTAMP } from "../src/media.ts";
import { encode } from "fec-decoder/src/encoder.ts";
import { blockDatagrams, blockLimitErrors, sourceDropper, SOURCE_TRACK } from "../src/producer.ts";
import { BlockCollector } from "../src/collector.ts";

interface MBlock { block: number; k: number; m: number; objects: string[]; frames: string[];
  source_objects: string[]; repair_objects: string[] }
const V = JSON.parse(readFileSync(new URL("../../fec-decoder/test/media-vectors.json", import.meta.url), "utf8")) as
  { blocks: MBlock[] };
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const RUNGS = [0.15, 0.15, 0.15];

for (const b of V.blocks) {
  const objects = b.objects.map(bytes);

  test(`block ${b.block}: LOC objects as media.py packs them`, () => {
    objects.forEach((o, i) => {
      const { props, payload } = unpackLocObject(o);
      assert.deepEqual(payload, bytes(b.frames[i]));
      const { entries } = decodePropertyBlock(props, 0, { profile: "d18-delta-vi64" });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].id, LOC_PROP_TIMESTAMP);
      assert.deepEqual(packLocObject(locProperties(Number(entries[0].value)), payload), o);
    });
  });

  test(`block ${b.block}: src and rep1..3 datagrams byte for byte`, () => {
    const d = [...blockDatagrams(b.block, objects, RUNGS)];
    const src = d.filter((x) => x.track === SOURCE_TRACK);
    const rep = d.filter((x) => x.track !== SOURCE_TRACK);
    assert.deepEqual(src.map((x) => x.payload), b.source_objects.map(bytes));
    assert.deepEqual(rep.map((x) => x.payload), b.repair_objects.map(bytes));
    assert.deepEqual(src.map((x) => [x.group, x.object]), src.map((_, j) => [b.block, j]));
    // three rungs of round(k * 0.15) symbols, object ids = global repair index, after all the source
    assert.deepEqual(rep.map((x) => x.track), ["rep1", "rep2", "rep3"].flatMap((t) => Array(b.m / 3).fill(t)));
    assert.deepEqual(rep.map((x) => x.object), [...Array(b.m).keys()]);
    assert.equal(d.findIndex((x) => x.track !== SOURCE_TRACK), b.k);
  });

  test(`block ${b.block}: lost source datagrams come back through the collector`, () => {
    const c = new BlockCollector();
    const d = [...blockDatagrams(b.block, objects, RUNGS)];
    const lostSrc = new Set([0, 3, 7]);
    d.forEach((x) => { if (!(x.track === SOURCE_TRACK && lostSrc.has(x.object))) c.add(x.track, x.group, x.object, x.payload); });
    const r = c.decode(b.block);
    assert.ok(r.status === "recovered", r.status);
    assert.deepEqual(r.objects, objects);
  });

  test(`block ${b.block}: more source lost than repair received -> lost, not thrown`, () => {
    const c = new BlockCollector();
    for (const x of blockDatagrams(b.block, objects, RUNGS)) {
      if (x.track === "rep2" || x.track === "rep3" || (x.track === SOURCE_TRACK && x.object <= b.m / 3)) continue;
      c.add(x.track, x.group, x.object, x.payload);
    }
    assert.equal(c.decode(b.block).status, "lost");
  });
}

test("no rungs: source datagrams only", () => {
  const d = [...blockDatagrams(0, V.blocks[0].objects.map(bytes), [])];
  assert.ok(d.every((x) => x.track === SOURCE_TRACK));
  assert.equal(d.length, V.blocks[0].k);
});

test("several blocks to a group: object q * 256 + j, the block recovered from its address", () => {
  const objects = V.blocks[0].objects.map(bytes);
  const d = [...blockDatagrams(13, objects, RUNGS, 10)];
  assert.ok(d.every((x) => x.group === 1));
  assert.equal(d[0].object, 3 * 256);
  const c = new BlockCollector(10);
  d.slice(1).forEach((x) => c.add(x.track, x.group, x.object, x.payload));
  assert.deepEqual(c.blockIds(), [13]);
  assert.equal(c.decode(13).status, "recovered");
});

test("sourceDropper: only src, about p of it, the same pattern for the same seed", () => {
  const d = [...blockDatagrams(0, V.blocks[0].objects.map(bytes), RUNGS)];
  const many = Array.from({ length: 200 }, () => d).flat();
  const run = (seed: number) => many.map(sourceDropper(0.1, seed));
  const a = run(7);
  assert.deepEqual(a, run(7));
  assert.ok(many.every((x, i) => !a[i] || x.track === SOURCE_TRACK));
  const rate = a.filter(Boolean).length / many.filter((x) => x.track === SOURCE_TRACK).length;
  assert.ok(rate > 0.08 && rate < 0.12, `drop rate ${rate}`);
  assert.ok(many.map(sourceDropper(0, 7)).every((x) => !x));
});

test("source before encoding: every src datagram is handed out before the repair is encoded", async () => {
  const b = V.blocks[0];
  const out: string[] = [];
  const enc = (src: Uint8Array[], m: number) => { out.push("encode"); return encode(src, m); };
  for (const d of blockDatagrams(b.block, b.objects.map(bytes), RUNGS, 1, enc)) {
    out.push(d.track);
    await new Promise((r) => setImmediate(r));   // a send that yields, as sendDatagram does
  }
  assert.equal(out.indexOf("encode"), b.k);
  assert.ok(out.slice(0, b.k).every((t) => t === SOURCE_TRACK));
  assert.ok(out.slice(b.k + 1).every((t) => t !== SOURCE_TRACK && t !== "encode"));
  assert.equal(out.length, b.k + 1 + b.m);
});

test("blockLimitErrors: an object over 65535 B, k + m over 256, too many objects for a datagram", () => {
  const ok = V.blocks.map((b) => b.objects.map(bytes));
  assert.deepEqual(blockLimitErrors(ok, RUNGS), []);
  const big = [new Uint8Array(70_000), new Uint8Array(10)];
  assert.match(blockLimitErrors([big], RUNGS)[0], /^block 0: object\(s\) 0 \(70000 B\) over 65535 B$/);
  const heavy = Array.from({ length: 12 }, () => new Uint8Array(20_000));   // k 219, m 3 * 33 = 99
  assert.deepEqual(blockLimitErrors([heavy], RUNGS), ["block 0: k 219 + m 99 = 318 symbols, over 256"]);
  assert.deepEqual(blockLimitErrors([heavy], []), []);
  assert.match(blockLimitErrors([Array.from({ length: 30 }, () => new Uint8Array(5))], [])[0], /30 objects make a 1162 B/);
});
