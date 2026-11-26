// A Node subscriber through the relay: SUBSCRIBE to catalog, src and the rungs the catalog lists,
// count objects per track, rebuild each block with web/fec-decoder and compare its frames with the
// clip's. Prints one JSON summary; exits 1 if no src datagram arrived or a frame differs.
//
//   node scripts/subscribe-check.ts --url URL --hash HEX --ns NS --media CLIP.mp4 [--take 3] [--secs 15]

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { connect } from "../src/connect.ts";
import { BlockCollector } from "../src/collector.ts";
import { MediaBlocks, unpackLocObject } from "../src/media.ts";
import { readVideoTrack } from "../src/mp4.ts";
import { SOURCE_TRACK } from "../src/producer.ts";

const { values: a } = parseArgs({
  options: {
    url: { type: "string" }, hash: { type: "string" }, ns: { type: "string" }, media: { type: "string" },
    take: { type: "string", default: "3" }, secs: { type: "string", default: "15" },
  },
});
if (!a.url || !a.ns || !a.media) {
  console.error("usage: node scripts/subscribe-check.ts --url URL [--hash HEX] --ns NS --media CLIP.mp4 [--take N] [--secs S]");
  process.exit(2);
}
const say = (l: string) => console.error(`${new Date().toISOString()} [sub] ${l}`);
const te = new TextEncoder(), td = new TextDecoder();
const ns = [te.encode(a.ns)];

// Datagrams can arrive before subscribeTrack() resolves with the alias: keep them by alias.
const aliasTrack = new Map<bigint, string>();
const counts: Record<string, number> = {};
const received: [bigint, number, number, Uint8Array][] = [];
const seen = new Set<bigint>();

const { conn, close } = await connect(a.url, a.hash, (c) => {
  c.onDatagram = (d) => {
    if (!seen.has(d.trackAlias)) seen.add(d.trackAlias), say(`first datagram on alias ${d.trackAlias}: group ${d.groupId} object ${d.objectId} ${d.payload.length} B`);
    received.push([d.trackAlias, Number(d.groupId), Number(d.objectId), d.payload.slice()]);
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
const fec = src["x-fec"] as { blocksPerGroup: number; rungs: string[] };
const want = [SOURCE_TRACK, ...fec.rungs.slice(0, Number(a.take))];
for (const name of want) {
  const sub = await conn.subscribeTrack(ns, te.encode(name), {});
  aliasTrack.set(sub.trackAlias, name);
  say(`SUBSCRIBED ${name} alias ${sub.trackAlias}`);
}

await new Promise((r) => setTimeout(r, Number(a.secs) * 1000));
await close();

const collector = new BlockCollector(fec.blocksPerGroup);
for (const [alias, group, object, payload] of received) {
  const track = aliasTrack.get(alias) ?? `alias${alias}`;
  counts[track] = (counts[track] ?? 0) + 1;
  collector.add(track, group, object, payload);
}

const media = new MediaBlocks(readVideoTrack(new Uint8Array(readFileSync(a.media))), (src["x-fec"] as { blockObjects: number }).blockObjects, 0);
const ids = collector.blockIds().slice(1, -1);   // the first and last block can be partial (join, stop)
const tally = { intact: 0, recovered: 0, lost: 0, frameMismatch: 0 };
const lostDetail: string[] = [];
for (const b of ids) {
  const r = collector.decode(b);
  tally[r.status]++;
  if (r.status === "lost") { lostDetail.push(`block ${b}: k ${r.k} source ${r.source} repair ${r.repair}`); continue; }
  const want = media.payloads(b);
  r.objects.forEach((o, i) => {
    if (Buffer.compare(unpackLocObject(o).payload, want[i]) !== 0) tally.frameMismatch++;
  });
}
const out = { tracks: counts, blocksChecked: ids.length, ...tally, malformed: collector.malformed, lostDetail };
console.log(JSON.stringify(out, null, 1));
process.exit(counts[SOURCE_TRACK] && tally.frameMismatch === 0 ? 0 : 1);
