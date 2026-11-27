// The publisher against a stand-in MoqtConnection: SUBSCRIBE filters and the Largest Object in
// SUBSCRIBE_OK, without a relay.
//
//   node --test test/publisher.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageParam, vi64EncodingLength, writeVi64, type SubscriptionFilter } from "@openmoq/transport";
import type { MoqtConnection } from "@openmoq/webtransport";
import { MediaBlocks } from "../src/media.ts";
import { blockDatagrams } from "../src/producer.ts";
import { FecPublisher } from "../src/publisher.ts";
import { filterWindow, requestedFilter, subscribeOkParams, type Location } from "../src/filter.ts";

/** A draft-18 SUBSCRIPTION_FILTER value (§5.1.2): Filter Type, then for AbsoluteStart its Start Location, as vi64. */
function filterBytes(f: SubscriptionFilter): Uint8Array {
  const type = { NextGroupStart: 1n, LargestObject: 2n, LatestObject: 2n, AbsoluteStart: 3n }[f.type as string]!;
  const fields = f.type === "AbsoluteStart" ? [type, f.startGroup, f.startObject] : [type];
  const out = new Uint8Array(fields.reduce((n, v) => n + vi64EncodingLength(v), 0));
  fields.reduce((at, v) => { writeVi64(v, out, at); return at + vi64EncodingLength(v); }, 0);
  return out;
}
const params = (f?: SubscriptionFilter) =>
  new Map<bigint, unknown[]>(f ? [[MessageParam.SUBSCRIPTION_FILTER, [filterBytes(f)]]] : []);

type Sent = { alias: bigint; group: bigint; object: bigint };

/** Records what the publisher writes; `onDatagram` runs before each datagram is recorded. */
class FakeConn {
  onSubscribe?: (id: bigint, ns: Uint8Array[], name: Uint8Array, p: Map<bigint, unknown>) => void;
  onSubscribeClosed?: (id: bigint) => void;
  /** Runs while a subgroup stream is being opened, before it is returned. */
  onOpen: () => Promise<void> | void = () => {};
  /** Return a promise that never settles to hang an object's write. */
  objectWrite: () => Promise<void> | void = () => {};
  accepted = new Map<bigint, { alias: bigint; largest?: Location }>();
  datagrams: Sent[] = [];
  subgroups: Sent[] = [];
  onDatagram: (d: Sent) => void = () => {};
  /** How long a datagram's write takes, in ms (a slow send path). */
  delay: (d: Sent) => number = () => 0;
  /** When each datagram's write began, in the order of `datagrams`. */
  times: number[] = [];
  onObject: (d: Sent) => void = () => {};
  private nextId = 0n;

  subscribe(name: string, f?: SubscriptionFilter): bigint {
    const id = this.nextId++;
    this.onSubscribe!(id, [], new TextEncoder().encode(name), params(f));
    return id;
  }
  async publishNamespace() { return 0n; }
  async acceptSubscribe(id: bigint, alias: bigint, o?: { parameters?: Map<bigint, unknown[]> }) {
    this.accepted.set(id, { alias, largest: o?.parameters?.get(MessageParam.LARGEST_OBJECT)?.[0] as Location | undefined });
  }
  async rejectSubscribe() {}
  /** A write in progress: as the session's datagram writer, a second one at once fails. */
  private writing = false;
  async sendDatagram(alias: bigint, group: bigint, object: bigint) {
    if (this.writing) throw new Error("Invalid state: WritableStream is locked");
    const d = { alias, group, object };
    const at = performance.now();
    const ms = this.delay(d);
    this.writing = true;
    try { if (ms) await new Promise((r) => setTimeout(r, ms)); } finally { this.writing = false; }
    this.onDatagram(d);
    this.datagrams.push(d);
    this.times.push(at);
  }
  streams: { alias: bigint; group: bigint; firstObject?: boolean; objects: bigint[]; props: Uint8Array[]; end?: string }[] = [];
  async openSubgroup(alias: bigint, group: bigint, _sub: bigint, o: { firstObject?: boolean }) {
    await this.onOpen();
    this.streams.push({ alias, group, firstObject: o.firstObject, objects: [], props: [] });
    return { alias, group, i: this.streams.length - 1 };
  }
  async sendObject(s: { alias: bigint; group: bigint; i: number }, object: bigint, _p: Uint8Array, props?: Uint8Array) {
    await this.objectWrite();
    this.onObject({ alias: s.alias, group: s.group, object });
    this.subgroups.push({ alias: s.alias, group: s.group, object });
    this.streams[s.i].objects.push(object);
    if (props) this.streams[s.i].props.push(props);
  }
  async closeSubgroup(s: { i: number }) { this.streams[s.i].end = "fin"; }
  async resetSubgroup(s: { i: number }) { this.streams[s.i].end = "reset"; }
  async publishDone() {}
}

// 6 blocks of 12 frames, 2 blocks per group (a GOP of 24): groups 0, 1 and 2.
const samples = Array.from({ length: 48 }, (_, i) => ({ payload: new Uint8Array(900).fill(i), key: i % 24 === 0 }));
const media = new MediaBlocks({ codec: "av01.0.04M.08", width: 2, height: 2, fps: 60, samples }, 12, 0.005, 24);
const RUNGS = [0.15, 0.15, 0.15];
const ALL = Array.from({ length: 6 }, (_, b) => [...blockDatagrams(b, media.objects(b, 0), RUNGS, 2)]).flat();
const at = (track: string, from: [number, number]) => ALL.filter((d) => d.track === track
  && (d.group > from[0] || (d.group === from[0] && d.object >= from[1]))).map((d) => [d.group, d.object]);

async function run(subscribe: (c: FakeConn) => void, plain?: string): Promise<FakeConn> {
  const c = new FakeConn();
  const pub = new FecPublisher({ url: "", namespace: "ns", media, catalog: new Uint8Array([1]), rungs: RUNGS,
    blocks: 6, log: () => {}, plain });
  pub.attach(c as unknown as MoqtConnection);
  subscribe(c);
  await pub.serve();
  await pub.done;
  await pub.stop();
  return c;
}

const sentTo = (c: FakeConn, id: bigint) =>
  c.datagrams.filter((d) => d.alias === c.accepted.get(id)!.alias).map((d) => [Number(d.group), Number(d.object)]);

test("filters: subscriptions made in group 0's second block get what their filter selects", async () => {
  const ids: Record<string, bigint> = {};
  const c = await run((c) => {
    ids.first = c.subscribe("src");
    c.onDatagram = (d) => {
      // block 1's first source datagram: group 0, object 256
      if (ids.next === undefined && d.group === 0n && d.object === 256n) {
        ids.next = c.subscribe("rep1", { type: "NextGroupStart" });
        ids.largest = c.subscribe("rep2", { type: "LargestObject" });
        ids.abs = c.subscribe("src", { type: "AbsoluteStart", startGroup: 2n, startObject: 0n });
        ids.whole = c.subscribe("rep3");
      }
    };
  });
  const rep1 = ALL.filter((d) => d.track === "rep1" && d.group === 0);
  // SUBSCRIBE_OK reports the last object each track sent: block 0's
  assert.deepEqual(c.accepted.get(ids.next)!.largest, { group: 0n, object: BigInt(rep1.filter((d) => d.object < 256).at(-1)!.object) });
  assert.equal(c.accepted.get(ids.first)!.largest, undefined);
  assert.deepEqual(sentTo(c, ids.first), at("src", [0, 0]));
  assert.deepEqual(sentTo(c, ids.next), at("rep1", [1, 0]));                       // not block 1: it is mid-group
  // LargestObject and no filter open after block 0's repair, but block 1's source has started:
  // both start at block 2 (group 1), not with block 1's repair
  assert.deepEqual(sentTo(c, ids.largest), at("rep2", [1, 0]));
  assert.deepEqual(sentTo(c, ids.abs), at("src", [2, 0]));
  assert.deepEqual(sentTo(c, ids.whole), at("rep3", [1, 0]));
});

test("join: src and the rungs subscribed mid-block start at the same block start; AbsoluteStart where it says", async () => {
  const ids: Record<string, bigint> = {};
  const c = await run((c) => {
    c.onDatagram = (d) => {
      // block 3's third source datagram (group 1, object 258), with no subscriber on the rungs yet
      if (ids.src === undefined && d.group === 1n && d.object === 258n) {
        ids.src = c.subscribe("src", { type: "LargestObject" });
        ids.rep1 = c.subscribe("rep1", { type: "LargestObject" });
        ids.rep2 = c.subscribe("rep2");
        ids.abs = c.subscribe("rep3", { type: "AbsoluteStart", startGroup: 1n, startObject: 256n });
      }
    };
    c.subscribe("src");
  });
  assert.deepEqual(c.accepted.get(ids.src)!.largest, { group: 1n, object: 258n });
  assert.deepEqual(sentTo(c, ids.src), at("src", [2, 0]));          // block 4, not the rest of block 3
  assert.deepEqual(sentTo(c, ids.rep1), at("rep1", [2, 0]));        // block 3's repair is still to come: skipped
  assert.deepEqual(sentTo(c, ids.rep2), at("rep2", [2, 0]));
  assert.deepEqual(sentTo(c, ids.abs), at("rep3", [1, 256]));       // block 3's repair
});

test("filters: the catalog's group at SUBSCRIBE is after the Largest Object, so NextGroupStart takes it", async () => {
  const c = new FakeConn();
  const pub = new FecPublisher({ url: "", namespace: "ns", media, catalog: new Uint8Array([1]), rungs: [], blocks: 0,
    log: () => {} });
  pub.attach(c as unknown as MoqtConnection);
  await pub.serve();
  const a = c.subscribe("catalog");
  await new Promise((r) => setTimeout(r, 5));
  const b = c.subscribe("catalog", { type: "NextGroupStart" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(c.accepted.get(b)!.largest, { group: 0n, object: 0n });
  assert.deepEqual(c.subgroups.map((s) => [s.alias, s.group]), [[c.accepted.get(a)!.alias, 0n], [c.accepted.get(b)!.alias, 1n]]);
  await pub.stop();
});

test("requestedFilter and subscribeOkParams: the draft-18 parameters", () => {
  assert.equal(requestedFilter(params()), undefined);
  assert.deepEqual(requestedFilter(params({ type: "AbsoluteStart", startGroup: 7n, startObject: 3n })),
    { type: "AbsoluteStart", startGroup: 7n, startObject: 3n });
  assert.deepEqual(filterWindow({ type: "NextGroupStart" }, { group: 4n, object: 9n }).start, { group: 5n, object: 0n });
  assert.deepEqual(filterWindow({ type: "NextGroupStart" }, undefined).start, { group: 0n, object: 0n });
  assert.equal(subscribeOkParams(undefined).size, 0);
  assert.deepEqual(subscribeOkParams({ group: 2n, object: 5n }).get(MessageParam.LARGEST_OBJECT), [{ group: 2n, object: 5n }]);
});

test("plain track: a stream per group, FIRST_OBJECT and FIN, joined at a group start; the frames' LOC properties", async () => {
  const ids: Record<string, bigint> = {};
  const c = await run((c) => {
    ids.first = c.subscribe("video");
    c.onObject = (d) => {
      // at block 1's first frame (group 0's second block)
      if (ids.late === undefined && d.group === 0n && d.object === 12n) {
        ids.late = c.subscribe("video", { type: "LargestObject" });
        ids.next = c.subscribe("video", { type: "NextGroupStart" });
        ids.abs = c.subscribe("video", { type: "AbsoluteStart", startGroup: 1n, startObject: 5n });
      }
    };
  }, "video");
  const streams = (id: bigint) => c.streams.filter((s) => s.alias === c.accepted.get(id)!.alias)
    .map((s) => [Number(s.group), s.firstObject, s.objects.map(Number), s.end]);
  const all = Array.from({ length: 24 }, (_, i) => i);
  assert.deepEqual(streams(ids.first), [[0, true, all, "fin"], [1, true, all, "fin"], [2, true, all, "fin"]]);
  // block 1's objects (13..23) are in LargestObject's window, but the stream waits for the next group start
  assert.deepEqual(c.accepted.get(ids.late)!.largest, { group: 0n, object: 12n });
  assert.deepEqual(streams(ids.late), [[1, true, all, "fin"], [2, true, all, "fin"]]);
  assert.deepEqual(streams(ids.next), [[1, true, all, "fin"], [2, true, all, "fin"]]);
  assert.deepEqual(streams(ids.abs), [[1, false, all.slice(5), "fin"], [2, true, all, "fin"]]);
  // every object carries its LOC properties (their bytes: test/plain.test.ts)
  for (const st of c.streams) assert.equal(st.props.length, st.objects.length);
});

// Pacing: 4 blocks of 12 frames at 100 ms a block, a group per block.
const slowSamples = samples.map((s, i) => ({ ...s, key: i % 12 === 0 }));
const slow = new MediaBlocks({ codec: "av01.0.04M.08", width: 2, height: 2, fps: 60, samples: slowSamples }, 12, 0.1, 12);

async function paced(o: { paceSource: number; paceRepair: number; lateMs?: number }, setup: (c: FakeConn) => void) {
  const c = new FakeConn();
  const lines: string[] = [];
  const pub = new FecPublisher({ url: "", namespace: "ns", media: slow, catalog: new Uint8Array([1]), rungs: RUNGS,
    blocks: 4, log: (l) => lines.push(l), ...o });
  pub.attach(c as unknown as MoqtConnection);
  const ids = ["src", "rep1", "rep2", "rep3"].map((t) => c.subscribe(t));
  await new Promise((r) => setTimeout(r, 0));
  setup(c);
  const t0 = performance.now();
  await pub.serve();
  await pub.done;
  await pub.stop();
  const track = new Map(ids.map((id, i) => [c.accepted.get(id)!.alias, ["src", "rep1", "rep2", "rep3"][i]]));
  const sent = c.datagrams.map((d, i) => ({ track: track.get(d.alias)!, block: Number(d.group), at: c.times[i] - t0 }));
  return { pub, sent, lines };
}

test("pacing: a block's slow repair doesn't delay the next block's source", async () => {
  // every repair datagram takes 15 ms to write: after the block's 50 ms of source, its 3 x 2 repair
  // datagrams one after the other would end past the next block's slot
  const { pub, sent, lines } = await paced({ paceSource: 0.5, paceRepair: 0.4 },
    (c) => { c.delay = (d) => (d.alias === c.accepted.get(0n)!.alias ? 0 : 15); });
  for (let b = 0; b < 4; b++) {
    // at most the three rungs' writes in progress ahead of it
    const first = sent.find((d) => d.track === "src" && d.block === b)!;
    assert.ok(first.at - b * 100 < 60, `block ${b}'s source started ${first.at - b * 100} ms after its slot`);
  }
  assert.equal(pub.blocksStarted.late, 0);
  // every datagram written: no two writes at once
  assert.equal(sent.length, 4 * (sent.filter((d) => d.block === 0).length));
  for (const t of ["src", "rep1", "rep2", "rep3"]) assert.equal(pub.counters.get(t)!.failed, 0);
  assert.equal(lines.filter((l) => l.startsWith("LATE")).length, 0);
  assert.match(pub.summary(), /^blocks 4 late 0 /);
});

test("pacing: within a block the source goes first, and each rung sends its blocks in order", async () => {
  const { sent } = await paced({ paceSource: 0.5, paceRepair: 0.4 },
    (c) => { c.delay = (d) => (d.alias === c.accepted.get(0n)!.alias ? 0 : 15); });
  for (let b = 0; b < 4; b++) {
    const lastSrc = sent.map((d) => d.track === "src" && d.block === b).lastIndexOf(true);
    const firstRep = sent.findIndex((d) => d.track !== "src" && d.block === b);
    assert.ok(lastSrc >= 0 && firstRep > lastSrc, `block ${b}: repair before the end of its source`);
  }
  for (const t of ["rep1", "rep2", "rep3"]) {
    const blocks = sent.filter((d) => d.track === t).map((d) => d.block);
    assert.deepEqual(blocks, [...blocks].sort((x, y) => x - y));
    assert.deepEqual([...new Set(blocks)], [0, 1, 2, 3]);
  }
});

test("pacing: a block whose source starts late is logged and counted", async () => {
  // block 0's source datagrams take 15 ms each to write: its source runs past block 1's slot
  const { pub, lines } = await paced({ paceSource: 0.5, paceRepair: 0.4 },
    (c) => { c.delay = (d) => (d.alias === c.accepted.get(0n)!.alias && d.group === 0n ? 15 : 0); });
  assert.ok(pub.blocksStarted.late >= 1);
  assert.match(lines.find((l) => l.startsWith("LATE")) ?? "", /^LATE block 1: source starts \d+ ms after its slot$/);
  assert.match(pub.summary(), new RegExp(`^blocks 4 late ${pub.blocksStarted.late} \\(max \\d+ ms after the slot\\); `));
});

test("lifecycle: a subscription closed while a datagram is written doesn't cost the next one that datagram", async () => {
  const ids: Record<string, bigint> = {};
  const c = await run((c) => {
    ids.a = c.subscribe("src");
    ids.b = c.subscribe("src");
    c.onDatagram = (d) => { if (d.alias === c.accepted.get(ids.a)?.alias && d.object === 0n) c.onSubscribeClosed!(ids.a); };
  });
  assert.deepEqual(sentTo(c, ids.a), [[0, 0]]);
  assert.deepEqual(sentTo(c, ids.b), at("src", [0, 0]));
});

test("lifecycle: a plain subscription closed while its stream opens gets no object, and the stream is reset", async () => {
  const ids: Record<string, bigint> = {};
  const c = await run((c) => {
    ids.v = c.subscribe("video");
    c.onOpen = () => { if (c.streams.length === 0) c.onSubscribeClosed!(ids.v); };
  }, "video");
  assert.deepEqual(c.streams.map((s) => [s.objects.length, s.end]), [[0, "reset"]]);
});

test("lifecycle: stop() doesn't wait for ever on a plain write that never completes", async () => {
  const c = new FakeConn();
  const lines: string[] = [];
  const pub = new FecPublisher({ url: "", namespace: "ns", media, catalog: new Uint8Array([1]), rungs: RUNGS,
    plain: "video", stopWaitMs: 100, log: (l) => lines.push(l) });
  pub.attach(c as unknown as MoqtConnection);
  c.subscribe("video");
  c.objectWrite = () => (c.subgroups.length >= 3 ? new Promise<void>(() => {}) : undefined);
  await pub.serve();
  await new Promise((r) => setTimeout(r, 50));
  const t = performance.now();
  await pub.stop();
  assert.ok(performance.now() - t < 1000);
  assert.ok(lines.includes("STOP sending still pending; resetting the plain streams"));
  assert.deepEqual(c.streams.map((s) => s.end), ["reset"]);
});
