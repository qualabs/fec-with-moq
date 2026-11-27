// The encoder against ISA-L's repair, byte for byte: the reference vectors in vectors.json,
// media-vectors*.json and encoder-vectors.json. Then round trips through the decoder.
//
//   node --test test/encoder.test.ts

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { recoverSymbols } from "../src/decoder.ts";
import { encode, IncrementalEncoder } from "../src/encoder.ts";
import { fromSymbols, layoutBlock, toSymbols } from "../src/layout.ts";
import { parseRepairObject } from "../src/wire.ts";

interface Block { name?: string; block?: number; m: number; symbol_size?: number; sizes: number[];
  objects: string[]; repair_objects: string[] }
interface Golden { name: string; k: number; m: number; symbol_size: number; sizes: number[]; padding: number;
  objects: string[]; repair: string[] }

const load = (f: string) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

const wireSets: [string, Block[]][] = [
  ["vectors.json", load("./vectors.json").blocks],
  ["media-vectors.json", load("./media-vectors.json").blocks],
  ["media-vectors-gop120.json", load("./media-vectors-gop120.json").blocks],
];
for (const [file, blocks] of wireSets) for (const b of blocks) {
  test(`${file} ${b.name ?? `block ${b.block}`}: repair equals ISA-L's (m = ${b.m})`, () => {
    const lay = layoutBlock(b.sizes, b.symbol_size);
    const repair = encode(toSymbols(lay, b.objects.map(bytes)), b.m);
    assert.equal(repair.length, b.repair_objects.length);
    repair.forEach((r, j) => assert.deepEqual(r, parseRepairObject(bytes(b.repair_objects[j])).symbol, `repair ${j}`));
  });
}

const goldenUrl = new URL("./encoder-vectors.json", import.meta.url);
const golden: Golden[] = existsSync(goldenUrl) ? load("./encoder-vectors.json").cases : [];
test("encoder-vectors.json present", { skip: golden.length ? false : "no encoder-vectors.json" }, () => {});
for (const g of golden) {
  test(`encoder-vectors.json ${g.name}: repair equals ISA-L's`, () => {
    const lay = layoutBlock(g.sizes, g.symbol_size);
    assert.equal(lay.k, g.k);
    assert.equal(lay.k * g.symbol_size - g.sizes.reduce((a, s) => a + s, 0), g.padding);
    const repair = encode(toSymbols(lay, g.objects.map(bytes)), g.m);
    assert.deepEqual(repair, g.repair.map(bytes));
  });
}

// deterministic bytes (xorshift32), so a failure reproduces
function rand(seed: number) {
  let x = seed >>> 0 || 1;
  const next = () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), x >>> 0);
  return {
    int: (n: number) => next() % n,
    bytes: (n: number) => Uint8Array.from({ length: n }, () => next() & 0xff),
  };
}

const combos: [k: number, m: number, n: number][] = [
  [1, 0, 1100], [1, 1, 1100], [1, 3, 7], [3, 4, 1], [5, 3, 1100], [12, 6, 1100],
  [125, 57, 1100], [200, 56, 64], [255, 1, 16],
];
for (const [k, m, n] of combos) {
  test(`round trip k=${k} m=${m} n=${n}: drop up to m source symbols, the TS decoder rebuilds them`, () => {
    const r = rand(k * 1000 + m * 10 + n);
    const source = Array.from({ length: k }, () => r.bytes(n));
    const repair = encode(source, m);
    assert.equal(repair.length, m);
    const all = new Map(repair.map((s, j) => [j, s]));
    for (let t = 0; t < 8; t++) {
      const e = t === 0 ? Math.min(k, m) : r.int(Math.min(k, m) + 1);
      const missing = new Set<number>();
      while (missing.size < e) missing.add(r.int(k));
      const src = new Map<number, Uint8Array>();
      source.forEach((s, i) => { if (!missing.has(i)) src.set(i, s); });
      const reps = new Set<number>();                   // any e of the m repair symbols
      while (reps.size < e) reps.add(r.int(m));
      const res = recoverSymbols(k, src, new Map([...reps].map((j) => [j, all.get(j)!])));
      assert.ok(res.ok, res.ok ? "" : res.reason);
      assert.deepEqual(res.value, source, `e=${e} missing ${[...missing]}`);
    }
    if (m < k) {
      const src = new Map(source.slice(m + 1).map((s, i) => [i + m + 1, s]));
      assert.equal(recoverSymbols(k, src, all).ok, false, "e = m + 1 must fail");
    }
  });
}

test("round trip at object level: SPAN layout, last symbol padded, lost objects rebuilt", () => {
  const r = rand(7);
  const objects = Array.from({ length: 12 }, () => r.bytes(1 + r.int(2500)));
  const lay = layoutBlock(objects.map((o) => o.length));
  const symbols = toSymbols(lay, objects);
  const repair = encode(symbols, Math.min(lay.k, 9));
  const src = new Map(symbols.map((s, j) => [j, s]));
  for (const j of [0, 1, lay.k - 1]) src.delete(j);
  const res = recoverSymbols(lay.k, src, new Map(repair.map((s, j) => [j, s])));
  assert.ok(res.ok);
  assert.deepEqual(fromSymbols(lay, res.value), objects);
});

test("repair symbol j doesn't depend on m (rungs are additive)", () => {
  const source = Array.from({ length: 20 }, (_, i) => rand(i + 1).bytes(100));
  const big = encode(source, 30);
  for (const m of [1, 3, 7, 19]) assert.deepEqual(encode(source, m), big.slice(0, m));
});

test("incremental encoder, symbols added out of order, equals encode", () => {
  const r = rand(3);
  const source = Array.from({ length: 17 }, () => r.bytes(1100));
  const enc = new IncrementalEncoder(17, 9, 1100);
  for (const i of [...source.keys()].reverse()) enc.add(i, source[i]);
  assert.deepEqual(enc.repair(), encode(source, 9));
});

test("bad parameters throw", () => {
  const s = new Uint8Array(4);
  assert.throws(() => encode([], 1), RangeError);
  assert.throws(() => encode([s], -1), RangeError);
  assert.throws(() => encode(Array(200).fill(s), 57), RangeError);
  assert.throws(() => encode([s, new Uint8Array(5)], 1), RangeError);
  const enc = new IncrementalEncoder(2, 1, 4);
  enc.add(0, s);
  assert.throws(() => enc.add(0, s), RangeError);
  assert.throws(() => enc.add(2, s), RangeError);
  assert.throws(() => enc.repair(), RangeError);
});
