// The three-track catalog against fecmoq's catalog_json (catalog-vectors.json, from
// scripts/fec_catalog_vectors.py), byte for byte; and Playa's fecInfoFromCatalog on it.
//
//   node --test test/catalog.test.ts

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  catalog, catalogJson, type CatalogMedia, type CatalogOptions, formatG, packagingMetadata, parsePackagingMetadata,
  pyFloat, pyJson, pyRound,
} from "../src/catalog.ts";

interface Case extends CatalogOptions { media: CatalogMedia; json: string }

const url = new URL("./catalog-vectors.json", import.meta.url);
const v: { cases: Case[] } | null = existsSync(url) ? JSON.parse(readFileSync(url, "utf8")) : null;
const skip = v ? false : "run scripts/fec_catalog_vectors.py";

// playa:packages/player/src/fec-stage.ts fecInfoFromCatalog (60d877a), the source and rungs only
function fecInfoFromCatalog(plainName: string, tracks: Record<string, unknown>[]) {
  const meta = (t: Record<string, unknown>) => parsePackagingMetadata(String(t["packagingMetadata"] ?? ""));
  const src = tracks.find((t) => t["packaging"] === "x-fec-source" && meta(t)["plainTrack"] === plainName);
  if (!src || typeof src["name"] !== "string" || meta(src)["scheme"] !== "rs-cauchy-gf256") return null;
  const num = (s: string | undefined, d: number) => (s !== undefined && Number(s) > 0 ? Number(s) : d);
  const m = meta(src);
  const rungs = tracks
    .filter((t) => t["packaging"] === "x-fec-repair" && typeof t["name"] === "string" && meta(t)["source"] === src["name"])
    .map((t) => ({ name: t["name"] as string, rung: num(meta(t)["rung"], Infinity) }))
    .sort((a, b) => a.rung - b.rung)
    .map((r) => r.name);
  return {
    source: src["name"], symbolSize: num(m["symbolSize"], 1100), blockObjects: num(m["blockObjects"], 12),
    blocksPerGroup: Math.max(1, Math.floor(num(m["blocksPerGroup"], 1))), objectStride: num(m["objectStride"], 256), rungs,
  };
}

test("catalogJson equals catalog_json byte for byte", { skip }, () => {
  for (const c of v!.cases) {
    const out = catalogJson(c.media, c);
    assert.equal(new TextDecoder().decode(out), c.json, `${c.plain} ${c.gapS} ${c.rungs}`);
    assert.deepEqual(JSON.parse(c.json), catalog(c.media, c));
  }
});

test("Playa's fecInfoFromCatalog finds the source and the rungs", { skip }, () => {
  for (const c of v!.cases) {
    const tracks = JSON.parse(c.json).tracks;
    const info = fecInfoFromCatalog(c.plain ?? "video", tracks);
    if (!c.plain) {
      assert.equal(info, null);
      continue;
    }
    assert.deepEqual(info, {
      source: c.source, symbolSize: c.symbolSize, blockObjects: c.nObjects, blocksPerGroup: c.media.blocksPerGop,
      objectStride: c.objectStride, rungs: c.rungs.map((_, r) => `rep${r + 1}`),
    });
  }
});

test("defaults: source src, stride 256, plain video, rungs in order", () => {
  const cat = catalog({ codec: "av01", width: 2, height: 2, blocksPerGop: 10, sizes: [100, 200] },
    { nObjects: 12, gapS: 0.2, rungs: [0.15, 0.15], symbolSize: 1100, generatedAt: 1 });
  assert.deepEqual(cat.tracks.map((t) => [t.name, t.packaging]),
    [["video", "loc"], ["src", "x-fec-source"], ["rep1", "x-fec-repair"], ["rep2", "x-fec-repair"]]);
  assert.equal(cat.tracks[0].bitrate, 4800);
  assert.deepEqual(fecInfoFromCatalog("video", cat.tracks)?.rungs, ["rep1", "rep2"]);
});

test("Python number formatting: repr, round, :g", () => {
  assert.deepEqual([60, 0.062, 2.55e16, 1e-5, 1e15, 0.0001, -1.5].map(pyFloat),
    ["60.0", "0.062", "2.55e+16", "1e-05", "1000000000000000.0", "0.0001", "-1.5"]);
  assert.deepEqual([[0.0625, 3], [0.1875, 3], [2.675, 2], [56.7000000001, 3]].map(([x, n]) => pyRound(x, n)),
    [0.062, 0.188, 2.67, 56.7]);
  assert.deepEqual([0.2, 1, 1e-5, 0.123456789, 1234565, 1234575, 999999.5, 0.00012, 100000].map(formatG),
    ["0.2", "1", "1e-05", "0.123457", "1.23456e+06", "1.23458e+06", "1e+06", "0.00012", "100000"]);
  assert.equal(pyJson({ a: "víd\u007f\"", b: [1, true, null], framerate: 2 }),
    '{"a": "v\\u00edd\\u007f\\"", "b": [1, true, null], "framerate": 2.0}');
  assert.throws(() => packagingMetadata({ a: "x;y" }), RangeError);
  assert.deepEqual(parsePackagingMetadata("a=1;a=2;;junk;b="), { a: "1", b: "" });
});
