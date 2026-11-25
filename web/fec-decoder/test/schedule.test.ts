// The block schedule against fecmoq's (schedule-vectors.json, from scripts/fec_schedule_vectors.py):
// rung slices, addresses, the GOP cut, and two blocks' source and repair objects as track_objects
// writes them; plus the inverse Playa applies to an object's (group, object).
//
//   node --test test/schedule.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeBlock } from "../src/decoder.ts";
import { encode } from "../src/encoder.ts";
import { layoutBlock, toSymbols } from "../src/layout.ts";
import {
  address, cutBlocks, OBJECT_STRIDE, repairAddress, repairObjects, repairTrackName, roundHalfEven, rungSlices,
  sourceObjects, type TrackObject,
} from "../src/schedule.ts";

type Row = [number, number, boolean, string];
interface Vectors {
  rung_slices: { fracs: number[]; by_k: [number, number][][] }[];
  addresses: { bpg: number; b: number; n: number; j: number; address: [number, number, boolean];
               repair_address: [number, number, boolean] }[];
  cut_blocks: { n: number; gop: number | null; keys: boolean[]; blocks?: number[][]; blocks_per_group?: number;
                error?: string }[];
  objects: { b: number; bpg: number; fracs: number[]; sizes: number[]; objects: string[]; slices: [number, number][];
             source: Row[]; repair: Row[][] }[];
}

const url = new URL("./schedule-vectors.json", import.meta.url);
const v: Vectors | null = existsSync(url) ? JSON.parse(readFileSync(url, "utf8")) : null;
const skip = v ? false : "run scripts/fec_schedule_vectors.py";
const sha = (p: Uint8Array) => createHash("sha256").update(p).digest("hex");
const rows = (xs: TrackObject[]): Row[] => xs.map((x) => [x.group, x.object, x.groupStart, sha(x.payload)]);

// playa:packages/player/src/fec-stage.ts locate(), FecStage's inverse of address()
function locate(group: number, object: number, blocksPerGroup: number): [number, number] {
  if (blocksPerGroup === 1) return [group, object];
  return [group * blocksPerGroup + Math.floor(object / OBJECT_STRIDE), object % OBJECT_STRIDE];
}

test("roundHalfEven is Python's round(): ties to even", () => {
  assert.deepEqual([0.5, 1.5, 2.5, 4.5, 10.5, 0.49, 0.51, 3, 2.4999].map(roundHalfEven), [0, 2, 2, 4, 10, 0, 1, 3, 2]);
  assert.deepEqual(rungSlices(30, [0.15, 0.15, 0.15]), [{ start: 0, stop: 4 }, { start: 4, stop: 8 }, { start: 8, stop: 12 }]);
  assert.equal(Math.round(30 * 0.15), 5);
});

test("rungSlices equals rung_slices for k = 1..256", { skip }, () => {
  for (const c of v!.rung_slices) {
    c.by_k.forEach((s, i) => assert.deepEqual(rungSlices(i + 1, c.fracs).map((x) => [x.start, x.stop]), s, `${c.fracs} k=${i + 1}`));
  }
});

test("rungSlices: consecutive from 0, each rung at least one symbol", () => {
  for (const fracs of [[0.15, 0.15, 0.15], [0, 0.01, 0.9], [0.25]]) {
    for (let k = 1; k <= 256; k++) {
      const s = rungSlices(k, fracs);
      s.forEach((x, r) => {
        assert.equal(x.start, r ? s[r - 1].stop : 0);
        assert.ok(x.stop - x.start >= 1);
      });
    }
  }
  assert.deepEqual(rungSlices(10, []), []);
  assert.equal(repairTrackName(2), "rep2");
});

test("address and repairAddress equal BlockSchedule's for 1, 10 and 5 blocks per group", { skip }, () => {
  for (const a of v!.addresses) {
    assert.deepEqual(address(a.b, a.j, a.bpg), a.address, JSON.stringify(a));
    assert.deepEqual(repairAddress(a.b, a.n, a.j, a.bpg), a.repair_address, JSON.stringify(a));
  }
});

test("every rung opens each group at its first symbol; repair ids are address(b, j)'s", () => {
  for (const bpg of [1, 10]) {
    for (let b = 0; b < 3 * bpg; b++) {
      for (const s of rungSlices(40, [0.15, 0.15, 0.15])) {
        for (let j = s.start; j < s.stop; j++) {
          const [g, o, first] = repairAddress(b, j - s.start, j, bpg);
          assert.equal(first, b % bpg === 0 && j === s.start);
          assert.deepEqual([g, o], address(b, j, bpg).slice(0, 2));
        }
      }
    }
  }
});

test("Playa's locate() inverts address()", () => {
  for (const bpg of [1, 5, 10]) {
    for (let b = 0; b < 3 * bpg; b++) {
      for (let j = 0; j < OBJECT_STRIDE; j++) {
        const [g, o] = address(b, j, bpg);
        assert.deepEqual(locate(g, o, bpg), [b, j]);
      }
    }
  }
});

test("cutBlocks equals Mp4Gops' cut", { skip }, () => {
  for (const c of v!.cut_blocks) {
    const items = c.keys.map((key, i) => ({ i, key }));
    const run = () => cutBlocks(items, (x) => x.key, c.n, c.gop ?? undefined);
    if (c.error) {
      assert.throws(run, (e: Error) => e instanceof RangeError && c.error!.endsWith(e.message), c.error);
    } else {
      const r = run();
      assert.deepEqual(r.blocks.map((b) => b.map((x) => x.i)), c.blocks);
      assert.equal(r.blocksPerGroup, c.blocks_per_group);
    }
  }
});

test("sourceObjects and repairObjects equal track_objects' for the last block of a group and the next", { skip }, () => {
  for (const c of v!.objects) {
    const objects = c.objects.map((s) => new Uint8Array(Buffer.from(s, "base64")));
    const slices = rungSlices(layoutBlock(c.sizes).k, c.fracs);
    assert.deepEqual(slices.map((s) => [s.start, s.stop]), c.slices);
    const src = sourceObjects(c.b, objects, c.bpg);
    assert.deepEqual(rows(src), c.source);
    const repair = encode(toSymbols(layoutBlock(c.sizes), objects), slices.at(-1)!.stop);
    const rungs = slices.map((s) => repairObjects(c.b, s, c.sizes, repair, c.bpg));
    rungs.forEach((r, i) => assert.deepEqual(rows(r), c.repair[i], `rung ${i + 1}`));

    // a receiver placing repair by locate(): one source object lost, rebuilt from the rungs
    const wire = new Map<number, Uint8Array>();
    for (const x of rungs.flat()) {
      const [b, j] = locate(x.group, x.object, c.bpg);
      assert.equal(b, c.b);
      wire.set(j, x.payload);
    }
    const received = new Map(objects.map((o, i) => [i, o]));
    received.delete(1);
    const r = decodeBlock({ sizes: c.sizes, objects: received, repair: wire });
    assert.ok(r.ok, r.ok ? "" : r.reason);
    assert.deepEqual(r.value, objects);
    assert.equal(src.length, layoutBlock(c.sizes).k);
  }
});

test("bad input throws RangeError", () => {
  for (const f of [() => address(-1, 0), () => address(1.5, 0), () => address(0, -1), () => address(0, 0, 0),
    () => address(0, OBJECT_STRIDE, 10), () => repairAddress(0, -1, 0), () => repairAddress(0, 0.5, 0),
    () => cutBlocks([1, 2], () => true, 0), () => cutBlocks([1, 2], () => true, 2, 3)]) {
    assert.throws(f, RangeError);
  }
  assert.deepEqual(address(0, OBJECT_STRIDE), [0, OBJECT_STRIDE, false]);
});
