// A Node subscriber through the relay: SUBSCRIBE to catalog, src and the rungs the catalog lists,
// count objects per track, rebuild each block with web/fec-decoder and compare its frames with the
// clip's, and compare what arrived of each block with what the publisher sends (k source and each
// taken rung's slice, from the catalog and the clip). Only blocks after the last rung's SUBSCRIBE_OK
// and before the last one seen are counted; a block in that range with no datagram at all is lost.
// Prints one JSON summary; exits 1 if no src datagram arrived, a frame differs, or a check asked for
// with --expect-all / --expect-recovered fails.
//
//   node scripts/subscribe-check.ts --url URL --hash HEX --ns NS --media CLIP.mp4 [--take 3] [--secs 15]
//     [--expect-all] [--expect-recovered MIN] [--blocks-out FILE]
//
// --blocks-out writes every counted block's datagrams per track (received/sent) and its outcome, to
// set beside another subscriber's view of the same blocks.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { layoutBlock } from "fec-decoder/src/layout.ts";
import { address, rungSlices } from "fec-decoder/src/schedule.ts";
import { connect } from "../src/connect.ts";
import { BlockCollector } from "../src/collector.ts";
import { MediaBlocks, unpackLocObject } from "../src/media.ts";
import { readVideoTrack } from "../src/mp4.ts";
import { SOURCE_TRACK } from "../src/producer.ts";

const { values: a } = parseArgs({
  options: {
    url: { type: "string" }, hash: { type: "string" }, ns: { type: "string" }, media: { type: "string" },
    take: { type: "string", default: "3" }, secs: { type: "string", default: "15" },
    "expect-all": { type: "boolean", default: false }, "expect-recovered": { type: "string" },
    "blocks-out": { type: "string" },
  },
});
if (!a.url || !a.ns || !a.media) {
  console.error("usage: node scripts/subscribe-check.ts --url URL [--hash HEX] --ns NS --media CLIP.mp4 [--take N] [--secs S] "
    + "[--expect-all] [--expect-recovered MIN] [--blocks-out FILE]");
  process.exit(2);
}
const say = (l: string) => console.error(`${new Date().toISOString()} [sub] ${l}`);
const te = new TextEncoder(), td = new TextDecoder();
const ns = [te.encode(a.ns)];

// Datagrams can arrive before subscribeTrack() resolves with the alias: keep them by alias.
const aliasTrack = new Map<bigint, string>();
const counts: Record<string, number> = {};
const received: [alias: bigint, group: number, object: number, payload: Uint8Array, at: number][] = [];
const seen = new Set<bigint>();

const { conn, close } = await connect(a.url, a.hash, (c) => {
  c.onDatagram = (d) => {
    if (!seen.has(d.trackAlias)) seen.add(d.trackAlias), say(`first datagram on alias ${d.trackAlias}: group ${d.groupId} object ${d.objectId} ${d.payload.length} B`);
    received.push([d.trackAlias, Number(d.groupId), Number(d.objectId), d.payload.slice(), performance.now()]);
  };
});
say(`connected ${a.url}`);

// The catalog: its first object says how many blocks to a group and which rungs exist.
let catalog: { tracks: Record<string, unknown>[] } | null = null;
const gotCatalog = new Promise<void>((resolve) => {
  void conn.subscribeTrack(ns, te.encode("catalog"), {
    onObject: (o) => {
      if (o.kind !== "data") return;
      counts.catalog = (counts.catalog ?? 0) + 1;
      if (!catalog) { catalog = JSON.parse(td.decode(o.payload)); say(`catalog group ${o.groupId}: ${o.payload.length} B`); resolve(); }
    },
  });
});
await Promise.race([gotCatalog, new Promise((_, rej) => setTimeout(() => rej(new Error("no catalog in 10 s")), 10_000))]);

const src = catalog!.tracks.find((t) => t.packaging === "x-fec-source")!;
const fec = src["x-fec"] as { blocksPerGroup: number; blockObjects: number; rungs: string[]; rungFractions: number[] };
const take = Math.min(Number(a.take), fec.rungs.length);
const want = [SOURCE_TRACK, ...fec.rungs.slice(0, take)];
for (const name of want) {
  const sub = await conn.subscribeTrack(ns, te.encode(name), {});
  aliasTrack.set(sub.trackAlias, name);
  say(`SUBSCRIBED ${name} alias ${sub.trackAlias}`);
}
const tReady = performance.now();

await new Promise((r) => setTimeout(r, Number(a.secs) * 1000));
await close();

const bpg = fec.blocksPerGroup;
const blockOf = (group: number, object: number) => bpg === 1 ? group : group * bpg + Math.floor(object / 256);
const collector = new BlockCollector(bpg);
let beforeReady = -1, firstAfter = Infinity, last = -1;
const got = new Map<number, Record<string, number>>();
for (const [alias, group, object, payload, at] of received) {
  const track = aliasTrack.get(alias) ?? `alias${alias}`;
  counts[track] = (counts[track] ?? 0) + 1;
  collector.add(track, group, object, payload);
  const b = blockOf(group, object);
  if (at < tReady) beforeReady = Math.max(beforeReady, b); else firstAfter = Math.min(firstAfter, b);
  last = Math.max(last, b);
  const g = got.get(b) ?? {};
  g[track] = (g[track] ?? 0) + 1;
  got.set(b, g);
}

// Counted: after every block that had a datagram before the last SUBSCRIBE_OK (or after the first
// block seen, if none had), up to but not including the last block seen (cut by the stop).
const first = 1 + (beforeReady >= 0 ? beforeReady : firstAfter);
const ids = Number.isFinite(first) ? Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i) : [];

const clip = readVideoTrack(new Uint8Array(readFileSync(a.media)));
const media = new MediaBlocks(clip, fec.blockObjects, 0, fec.blockObjects * bpg);
const tally = { intact: 0, recovered: 0, lost: 0, missing: 0, frameMismatch: 0 };
const lostDetail: string[] = [];
const sent = { expected: 0, received: 0, missingSrc: 0, missingRep: 0, blocksShort: 0 };
const shortDetail: string[] = [];
const perBlock: Record<number, Record<string, string>> = {};
for (const b of ids) {
  // k from the block's own datagrams, or (none arrived) from the clip's LOC objects
  const g = got.get(b) ?? {};
  const k = layoutBlock(collector.sizes(b) ?? media.objects(b, Date.now() * 1000).map((o) => o.length)).k;
  const slices = rungSlices(k, fec.rungFractions);
  const expect: Record<string, number> = { [SOURCE_TRACK]: k };
  for (let r = 0; r < take; r++) expect[fec.rungs[r]] = slices[r].stop - slices[r].start;
  let short = 0;
  for (const [t, n] of Object.entries(expect)) {
    const have = g[t] ?? 0;
    sent.expected += n;
    sent.received += have;
    if (have < n) (t === SOURCE_TRACK ? (sent.missingSrc += n - have) : (sent.missingRep += n - have)), short++;
  }
  if (short) {
    sent.blocksShort++;
    if (shortDetail.length < 20) {
      shortDetail.push(`block ${b} (${address(b, 0, bpg).slice(0, 2).join(".")}): `
        + Object.entries(expect).map(([t, n]) => `${t} ${g[t] ?? 0}/${n}`).join(" "));
    }
  }
  perBlock[b] = Object.fromEntries(Object.entries(expect).map(([t, n]) => [t, `${g[t] ?? 0}/${n}`]));
  if (!collector.sizes(b)) { tally.missing++; perBlock[b].status = "missing"; lostDetail.push(`block ${b}: no datagram`); continue; }
  const r = collector.decode(b);
  tally[r.status]++;
  perBlock[b].status = r.status;
  if (r.status === "lost") { lostDetail.push(`block ${b}: k ${r.k} source ${r.source} repair ${r.repair}`); continue; }
  const want = media.payloads(b);
  r.objects.forEach((o, i) => {
    if (Buffer.compare(unpackLocObject(o).payload, want[i]) !== 0) tally.frameMismatch++;
  });
}

const failures: string[] = [];
if (!counts[SOURCE_TRACK]) failures.push("no src datagram");
if (tally.frameMismatch) failures.push(`${tally.frameMismatch} frame(s) differ from the clip`);
if (a["expect-all"] && sent.received < sent.expected) failures.push(`${sent.expected - sent.received} datagram(s) missing`);
if (a["expect-recovered"] !== undefined) {
  if (tally.recovered < Number(a["expect-recovered"])) failures.push(`recovered ${tally.recovered} < ${a["expect-recovered"]}`);
  if (tally.lost + tally.missing) failures.push(`${tally.lost + tally.missing} block(s) lost`);
}
const out = {
  tracks: counts, blocksChecked: ids.length, firstBlock: ids[0] ?? null, lastBlock: ids.at(-1) ?? null,
  ...tally, malformed: collector.malformed, datagrams: sent, shortDetail, lostDetail: lostDetail.slice(0, 20),
  ok: failures.length === 0, failures,
};
console.log(JSON.stringify(out, null, 1));
if (a["blocks-out"]) writeFileSync(a["blocks-out"], JSON.stringify(perBlock, null, 0).replace(/},/g, "},\n") + "\n");
process.exit(failures.length ? 1 : 0);
