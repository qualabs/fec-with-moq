// packRepairObject against wire.pack_repair, byte for byte (encoder-vectors.json, from
// scripts/fec_encoder_vectors.py), round trips through parseRepairObject, and a whole block from
// source objects to repair objects on the wire and back through the decoder.
//
//   node --test test/wire.test.ts

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeBlock } from "../src/decoder.ts";
import { encode } from "../src/encoder.ts";
import { layoutBlock, toSymbols } from "../src/layout.ts";
import { CODEC_ISAL, CODEC_ZFEC, DATAGRAM_MAX_PAYLOAD, packRepairObject, parseRepairObject } from "../src/wire.ts";

interface Golden { name: string; sizes: number[]; repair: string[]; packed: string[]; packed_indexed: string[] }

const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const goldenUrl = new URL("./encoder-vectors.json", import.meta.url);
const golden: Golden[] = existsSync(goldenUrl) ? JSON.parse(readFileSync(goldenUrl, "utf8")).cases : [];

test("encoder-vectors.json present", { skip: golden.length ? false : "run scripts/fec_encoder_vectors.py" }, () => {});
for (const g of golden) {
  test(`encoder-vectors.json ${g.name}: packed equals pack_repair's, plain and INDEXED`, () => {
    const repair = g.repair.map(bytes);
    assert.deepEqual(repair.map((r) => packRepairObject(g.sizes, r)), g.packed.map(bytes));
    assert.deepEqual(repair.map((r, j) => packRepairObject(g.sizes, r, CODEC_ISAL, j)), g.packed_indexed.map(bytes));
  });
}

test("round trip: parseRepairObject(packRepairObject(x)) equals x", () => {
  const symbol = Uint8Array.from({ length: 1100 }, (_, i) => (i * 7) & 0xff);
  const xs = [
    { codec: CODEC_ISAL, indexed: false, sizes: [47831, 6569, 1], index: null, symbol },
    { codec: CODEC_ISAL, indexed: true, sizes: [1100], index: 56, symbol },
    { codec: CODEC_ZFEC, indexed: true, sizes: [0xffff, 0], index: 0xffff, symbol: symbol.subarray(0, 10) },
    { codec: CODEC_ISAL, indexed: false, sizes: [], index: null, symbol: new Uint8Array(0) },
  ];
  for (const x of xs) assert.deepEqual(parseRepairObject(packRepairObject(x.sizes, x.symbol, x.codec, x.index)), x);
});

test("bad input throws RangeError", () => {
  const s = new Uint8Array(4);
  assert.throws(() => packRepairObject([1], s, 3), RangeError);
  assert.throws(() => packRepairObject(Array(256).fill(1), s), RangeError);
  assert.throws(() => packRepairObject([0x10000], s), RangeError);
  assert.throws(() => packRepairObject([-1], s), RangeError);
  assert.throws(() => packRepairObject([1.5], s), RangeError);
  assert.throws(() => packRepairObject([1], s, CODEC_ISAL, 0x10000), RangeError);
  assert.throws(() => packRepairObject([1], s, CODEC_ISAL, -1), RangeError);
  assert.throws(() => packRepairObject([1], new Uint8Array(DATAGRAM_MAX_PAYLOAD - 3)), RangeError);
  assert.equal(packRepairObject([1], new Uint8Array(DATAGRAM_MAX_PAYLOAD - 4)).length, DATAGRAM_MAX_PAYLOAD);
});

test("end to end: objects -> layout -> encode -> pack -> parse -> decode rebuilds lost objects", () => {
  let x = 11;
  const next = () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), x >>> 0);
  const objects = Array.from({ length: 12 }, () => Uint8Array.from({ length: 300 + (next() % 2200) }, () => next() & 0xff));
  const sizes = objects.map((o) => o.length);
  const lay = layoutBlock(sizes);
  const rung = Math.max(1, Math.round(lay.k * 0.3));
  const repair = encode(toSymbols(lay, objects), 3 * rung);
  // rung 1 keyed by global repair index (object id = j); rung 2 INDEXED, keyed by an unrelated object
  // id so only the index in the payload can place it; rung 3 not subscribed
  const wire = new Map<number, Uint8Array>();
  for (let j = 0; j < rung; j++) wire.set(j, packRepairObject(sizes, repair[j]));
  for (let n = 0; n < rung; n++) wire.set(100 + n, packRepairObject(sizes, repair[rung + n], CODEC_ISAL, rung + n));

  const received = new Map(objects.map((o, i) => [i, o]));
  received.delete(3);
  received.delete(7);
  const any = parseRepairObject(wire.values().next().value!);
  assert.deepEqual(any.sizes, sizes);
  const r = decodeBlock({ sizes: any.sizes, objects: received, repair: wire });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.deepEqual(r.value, objects);
});
