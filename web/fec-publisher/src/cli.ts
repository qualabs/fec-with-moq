// node src/cli.ts --url https://127.0.0.1:4473/moq-relay --hash HEX --ns NS --media clip.mp4 [--rungs 0.15,0.15,0.15]
// [--drop-src 0.05] [--seed 7] [--pace-source 0.5] [--pace-repair 0.4] [--secs 60]

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { catalogJson } from "fec-decoder/src/catalog.ts";
import { SYMBOL_SIZE } from "fec-decoder/src/layout.ts";
import { OBJECT_STRIDE } from "fec-decoder/src/schedule.ts";
import { MediaBlocks } from "./media.ts";
import { readVideoTrack } from "./mp4.ts";
import { blockLimitErrors, sourceDropper, SOURCE_TRACK } from "./producer.ts";
import { FecPublisher } from "./publisher.ts";

const { values: a } = parseArgs({
  options: {
    url: { type: "string" }, hash: { type: "string" }, ns: { type: "string" }, media: { type: "string" },
    objects: { type: "string", default: "12" }, gap: { type: "string", default: "0.2" },
    "gop-frames": { type: "string" }, rungs: { type: "string", default: "0.15,0.15,0.15" },
    "drop-src": { type: "string", default: "0" }, seed: { type: "string", default: "7" },
    secs: { type: "string" }, "catalog-interval": { type: "string", default: "2" },
    "plain-track": { type: "string", default: "video" },
    "pace-source": { type: "string", default: "0" }, "pace-repair": { type: "string", default: "0" },
  },
});
if (!a.url || !a.ns || !a.media) {
  console.error("usage: node src/cli.ts --url URL [--hash SHA256HEX] --ns NS --media CLIP.mp4 [--rungs F,F,F | --rungs ''] "
    + "[--objects 12] [--gap 0.2] [--gop-frames N] [--drop-src P] [--seed N] [--pace-source F] [--pace-repair F] [--secs S]");
  process.exit(2);
}

const n = Number(a.objects), gapS = Number(a.gap);
const rungs = a.rungs ? a.rungs.split(",").map(Number) : [];
const refuse = (why: string): never => { console.error(`REFUSED ${a.media}: ${why}`); process.exit(2); };
const track = readVideoTrack(new Uint8Array(readFileSync(a.media)));
let media!: MediaBlocks;
try { media = new MediaBlocks(track, n, gapS, a["gop-frames"] ? Number(a["gop-frames"]) : n); }
catch (e) { refuse((e as Error).message); }
// Every block of the clip, before anything is sent: a block that can't be packed would stop the run.
const limits = blockLimitErrors(media.blocks.map((_, b) => media.objects(b, Date.now() * 1000)), rungs);
if (limits.length) refuse(`${limits.length} block(s) can't be sent:\n  ${limits.slice(0, 10).join("\n  ")}`);
const catalog = catalogJson(media.catalogMedia(), {
  nObjects: n, gapS, rungs, symbolSize: SYMBOL_SIZE, source: SOURCE_TRACK, objectStride: OBJECT_STRIDE,
  plain: a["plain-track"] || null,
});
const say = (l: string) => console.log(`${new Date().toISOString()} ${l}`);
say(`MEDIA ${a.media}: ${media.blocks.length} blocks of ${n}, ${media.blocksPerGroup} per group, codec ${track.codec} `
  + `${track.width}x${track.height}@${track.fps}; catalog ${catalog.length} B; rungs [${rungs}]; drop-src ${a["drop-src"]}; pace source ${a["pace-source"]} repair ${a["pace-repair"]}`);

const pub = new FecPublisher({
  url: a.url, certHash: a.hash, namespace: a.ns, media, catalog, rungs,
  catalogIntervalS: Number(a["catalog-interval"]),
  drop: sourceDropper(Number(a["drop-src"]), Number(a.seed)),
  paceSource: Number(a["pace-source"]), paceRepair: Number(a["pace-repair"]),
  log: say,
  // As relay_fec.py's SESSION-DEAD: a publisher whose session is gone exits with status 4.
  onFatal: () => void stop(4),
});
const stats = setInterval(() => void pub.quicSummary().then((q) => say(`STATS ${pub.summary()}; ${q}`)), 5000);
let stopping = false;
const stop = async (code: number) => {
  if (stopping) return;
  stopping = true;
  clearInterval(stats);
  const q = await pub.quicSummary();
  await pub.stop();
  say(`DONE ${pub.summary()}; ${q}`);
  process.exit(code);
};
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
await pub.start().catch((e) => { say(`START FAILED ${(e as Error).stack}`); process.exit(1); });
if (a.secs) setTimeout(() => void stop(0), Number(a.secs) * 1000);
