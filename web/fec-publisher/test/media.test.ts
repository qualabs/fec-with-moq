// readVideoTrack against ffmpeg's own view of a clip it just encoded (skipped without ffmpeg with
// libsvtav1), and MediaBlocks' cut and LOC timestamps.
//
//   node --test test/media.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decodePropertyBlock } from "@openmoq/transport";
import { MediaBlocks, unpackLocObject } from "../src/media.ts";
import { readVideoTrack } from "../src/mp4.ts";

const hasSvt = (() => {
  try { return execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).includes("libsvtav1"); }
  catch { return false; }
})();

test("readVideoTrack: the samples, keys and codec ffmpeg sees", { skip: !hasSvt && "no ffmpeg with libsvtav1" }, () => {
  const dir = mkdtempSync(join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "fec-publisher-test-"));
  try {
    const clip = join(dir, "clip.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-frames:v", "36",
      "-c:v", "libsvtav1", "-preset", "12", "-g", "12", "-crf", "50", "-svtav1-params", "irefresh-type=2:pred-struct=1",
      "-pix_fmt", "yuv420p", clip]);
    const t = readVideoTrack(new Uint8Array(readFileSync(clip)));
    assert.equal(t.codec.slice(0, 7), "av01.0.");
    assert.deepEqual([t.width, t.height, t.fps, t.samples.length], [320, 180, 30, 36]);
    const md5 = execFileSync("ffmpeg", ["-v", "error", "-i", clip, "-c", "copy", "-f", "framemd5", "-"], { encoding: "utf8" })
      .split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").map((x) => x.trim()));
    assert.deepEqual(t.samples.map((s) => createHash("md5").update(s.payload).digest("hex")), md5.map((r) => r[5]));
    assert.deepEqual(t.samples.map((s, i) => [i, s.key]).filter(([, k]) => k).map(([i]) => i), [0, 12, 24]);
    const m = new MediaBlocks(t, 12, 0.4);
    assert.equal(m.blocks.length, 3);
    assert.equal(m.blocksPerGroup, 1);
    assert.equal(new MediaBlocks(t, 6, 0.2, 12).blocksPerGroup, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MediaBlocks: the clip loops, frame i of block b stamped t0 + b * gap + i * gap / n", () => {
  const samples = Array.from({ length: 24 }, (_, i) => ({ payload: new Uint8Array([i, i, i]), key: i % 12 === 0 }));
  const m = new MediaBlocks({ codec: "av01.0.04M.08", width: 2, height: 2, fps: 60, samples }, 12, 0.2);
  const objs = m.objects(3, 1_000_000);
  assert.deepEqual(unpackLocObject(objs[5]).payload, new Uint8Array([17, 17, 17]));
  const ts = objs.map((o) => decodePropertyBlock(unpackLocObject(o).props, 0, { profile: "d18-delta-vi64" }).entries[0].value);
  assert.equal(ts[0], 1_000_000n + 600_000n);
  assert.equal(ts[5], 1_000_000n + 600_000n + 83_333n);
  assert.deepEqual(m.catalogMedia().sizes, Array(24).fill(3));
});
