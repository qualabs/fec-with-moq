// The plain `video` track against media.py's PlainTrack: plain-vectors.json (a block per group) and
// plain-vectors-gop24.json (two blocks per group), from scripts/fec_plain_vectors.py, hold what
// PlainTrack.produce() writes for the first blocks of a clip and the frames it wrote them from.
//
//   node --test test/plain.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MediaBlocks } from "../src/media.ts";
import { plainObjects } from "../src/plain.ts";

interface PyObject { group: number; object: number; groupStart: boolean; properties: string; payload: string; timestamp: number }
interface Vectors { blockObjects: number; gapS: number; blocksPerGroup: number; t0Us: number;
  frames: { payload: string; key: boolean }[]; objects: PyObject[] }
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

for (const file of ["plain-vectors.json", "plain-vectors-gop24.json"]) {
  test(`${file}: objects, addresses and properties as PlainTrack writes them`, () => {
    const v = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as Vectors;
    const samples = v.frames.map((f) => ({ payload: bytes(f.payload), key: f.key }));
    const n = v.blockObjects;
    const media = new MediaBlocks({ codec: "av01.0.04M.08", width: 2, height: 2, fps: 60, samples }, n, v.gapS,
      n * v.blocksPerGroup);
    assert.equal(media.blocksPerGroup, v.blocksPerGroup);
    const ours = media.blocks.flatMap((_, b) => plainObjects(media, b, v.t0Us));
    assert.equal(ours.length, v.objects.length);
    ours.forEach((o, i) => {
      const p = v.objects[i];
      assert.deepEqual([o.group, o.object, o.groupStart], [p.group, p.object, p.groupStart], `object ${i}`);
      assert.deepEqual(o.properties, bytes(p.properties), `object ${i} properties`);
      assert.deepEqual(o.payload, bytes(p.payload), `object ${i} payload`);
    });
    // a group's last object ends its stream; the next object starts a group
    ours.forEach((o, i) => assert.equal(o.groupEnd, i === ours.length - 1 || ours[i + 1].groupStart));
  });
}

test("plain and src carry the same frames and timestamps", () => {
  const v = JSON.parse(readFileSync(new URL("plain-vectors.json", import.meta.url), "utf8")) as Vectors;
  const media = new MediaBlocks({ codec: "av01.0.04M.08", width: 2, height: 2, fps: 60,
    samples: v.frames.map((f) => ({ payload: bytes(f.payload), key: f.key })) }, v.blockObjects, v.gapS);
  const loc = media.objects(2, v.t0Us);
  plainObjects(media, 2, v.t0Us).forEach((o, i) => {
    const props = loc[i].subarray(2, 2 + ((loc[i][0] << 8) | loc[i][1]));
    assert.deepEqual(o.properties, props);
    assert.deepEqual(o.payload, loc[i].subarray(2 + props.length));
  });
});
