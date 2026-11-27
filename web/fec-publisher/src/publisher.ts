// The FEC publisher's MoQ side: announces the namespace, answers SUBSCRIBE for `catalog`, `src` and
// the repair rungs, sends the catalog as a new group every interval on its own subgroup stream, and
// each block's datagrams at the block rate, the source before the repair is encoded and each rung's
// repair as a task of its own, so the next block's source keeps its slot. Each
// subscription gets what its filter asks for, from the Largest Object its SUBSCRIBE_OK reports; a
// late subscription to `src` or a rung starts at a block start, the same block on every one. The
// plain track (`video`, for players without FEC) carries the same frames as LOC objects, a subgroup
// stream per group (GOP). FETCH is refused (NOT_SUPPORTED).

import { MAX_VI64, PublishDoneCode18, RequestError18, SubgroupIdMode, vi64EncodingLength,
  type SubscriptionWindow } from "@openmoq/transport";
import type { MoqtConnection } from "@openmoq/webtransport";
import { layoutBlock } from "fec-decoder/src/layout.ts";
import { repairTrackName } from "fec-decoder/src/schedule.ts";
import { connect } from "./connect.ts";
import { admits, describeFilter, filterWindow, Largest, requestedFilter, subscribeOkParams } from "./filter.ts";
import type { MediaBlocks } from "./media.ts";
import { plainObjects, type PlainObject } from "./plain.ts";
import { blockDatagrams, maxPayload, SOURCE_TRACK, type Datagram } from "./producer.ts";

export const CATALOG_TRACK = "catalog";

function until(t: number): Promise<void> | void {
  const ms = t - performance.now();
  if (ms > 0) return new Promise((r) => setTimeout(r, ms));
}

/** A draft-18 OBJECT_DATAGRAM header at its largest: type, alias, group, object (vi64 each), priority. */
export const MAX_DATAGRAM_HEADER = 1 + 3 * vi64EncodingLength(MAX_VI64) + 1;

/** Send failures are logged at the first one, then at most once per this many ms per track. */
const FAIL_LOG_MS = 5000;

/** How long stop() waits for the block loop, the repair and the plain track's queue (default). */
export const STOP_WAIT_MS = 2000;

/** A block whose source starts more than this many ms after its slot is logged as LATE (default). */
export const LATE_MS = 50;

export interface PublisherOptions {
  url: string;
  certHash?: string;
  namespace: string;
  media: MediaBlocks;
  catalog: Uint8Array;
  rungs: number[];
  /** The plain track's name (the catalog's `video`); none when absent. */
  plain?: string;
  catalogIntervalS?: number;
  /** Return true to drop a datagram before it is sent (simulated loss on the publisher). */
  drop?: (d: Datagram) => boolean;
  /** Spread a block's source datagrams evenly over this fraction of the block period (0: back to back). */
  paceSource?: number;
  /** Spread each rung's repair for a block evenly over this fraction of the block period, after the source. */
  paceRepair?: number;
  /** Stop after this many blocks (default: run until stop()). */
  blocks?: number;
  /** Log LATE when a block's source starts more than this many ms after its slot (default LATE_MS). */
  lateMs?: number;
  /** stop() waits at most this long for what is being sent, then resets the plain streams (default STOP_WAIT_MS). */
  stopWaitMs?: number;
  log?: (line: string) => void;
  /** The session ended without stop(), or the block loop threw: the publisher can't go on. */
  onFatal?: (why: string) => void;
}

interface Sub {
  requestId: bigint; alias: bigint; ready: boolean; window: SubscriptionWindow;
  /** The filter names a start Location (AbsoluteStart / AbsoluteRange): the plain track may open a group there. */
  absolute: boolean;
  /** A datagram track's first block: the next one whose source hadn't started when it became ready. */
  fromBlock: number;
}

export interface TrackCounters { sent: number; dropped: number; failed: number }

interface FailLog { at: number; since: number }

export class FecPublisher {
  readonly counters = new Map<string, TrackCounters>();
  private conn!: MoqtConnection;
  private closeConn: () => Promise<void> = async () => {};
  private datagramStats: () => Promise<{ expiredOutgoing: number; lostOutgoing: number } | null> = async () => null;
  private readonly subs = new Map<string, Sub[]>();
  private readonly largest = new Map<string, Largest>();
  /** Each plain subscription's open subgroup stream. */
  private readonly plainStreams = new Map<Sub, { group: number; stream: bigint }>();
  private plainQueue: Promise<void> = Promise.resolve();
  /** Each rung's repair, one block after the other (paced); one queue for all rungs when unpaced. */
  private readonly repairQueues = new Map<string, Promise<void>>();
  /** Blocks started, those whose source started late, and the latest start after a slot (ms). */
  readonly blocksStarted = { all: 0, late: 0, maxLateMs: 0 };
  private readonly failLog = new Map<string, FailLog>();
  private nextAlias = 1n;
  /** The last block whose source has started. */
  private sourceBlock = -1;
  private catalogGroup = 0n;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  /** stop() is done waiting: the plain track sends nothing more. */
  private plainCut = false;
  private readonly log: (line: string) => void;
  private readonly tracks: string[];
  private readonly o: PublisherOptions;
  done: Promise<void> = Promise.resolve();

  constructor(o: PublisherOptions) {
    this.o = o;
    this.log = o.log ?? ((l) => console.log(l));
    this.tracks = [CATALOG_TRACK, ...(o.plain ? [o.plain] : []), SOURCE_TRACK, ...o.rungs.map((_, r) => repairTrackName(r + 1))];
    for (const t of this.tracks) {
      this.subs.set(t, []);
      this.largest.set(t, new Largest());
      this.counters.set(t, { sent: 0, dropped: 0, failed: 0 });
    }
  }

  async start(): Promise<void> {
    const c = await connect(this.o.url, this.o.certHash, (conn) => this.attach(conn));
    this.closeConn = c.close;
    this.datagramStats = c.datagramStats;
    const worst = maxPayload(this.o.media.n) + MAX_DATAGRAM_HEADER;
    this.log(`CONNECTED ${this.o.url} draft 18; maxDatagramSize ${c.maxDatagramSize || "unknown"}, `
      + `largest datagram ${worst} B`);
    if (c.maxDatagramSize && worst > c.maxDatagramSize) {
      await c.close();
      throw new RangeError(`a ${this.o.media.n}-object block's datagram can reach ${worst} B, over the session's `
        + `maxDatagramSize ${c.maxDatagramSize} B; use fewer --objects`);
    }
    await this.serve();
  }

  /** Take the connection's callbacks (before SETUP). start() does it; a test can hand in its own connection. */
  attach(conn: MoqtConnection): void {
    this.conn = conn;
    conn.onSubscribe = (id, _ns, name, params) => void this.onSubscribe(id, new TextDecoder().decode(name), params);
    conn.onSubscribeClosed = (id) => this.onSubscribeClosed(id);
    conn.onFetch = (id) => {
      this.log(`FETCH ${id} refused`);
      void conn.rejectFetch(id, RequestError18.NOT_SUPPORTED, "FETCH not served").catch((e) => this.log(`rejectFetch: ${e}`));
    };
    conn.onError = (e) => { if (!this.stopped) this.log(`connection error: ${e.message}`); };
    conn.onClose = (code, reason) => { if (!this.stopped) this.fatal(`SESSION-DEAD connection closed: ${code} ${reason ?? ""}`); };
  }

  /** Announce the namespace and start the catalog timer and the block loop. */
  async serve(): Promise<void> {
    await this.conn.publishNamespace([new TextEncoder().encode(this.o.namespace)]);
    this.log(`ANNOUNCED ${this.o.namespace}`);
    this.timers.push(setInterval(() => void this.sendCatalog(), (this.o.catalogIntervalS ?? 2) * 1000));
    this.done = this.runBlocks();
    this.done.catch((e: unknown) => this.fatal(`block loop: ${(e as Error).stack ?? e}`));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    // Bounded: a write that never completes (a stream with no flow-control credit) mustn't hold stop().
    const limit = new Promise<void>((r) => { const t = setTimeout(r, this.o.stopWaitMs ?? STOP_WAIT_MS); t.unref(); });
    const settled = Promise.all([this.done.catch(() => {}), this.plainQueue.catch(() => {})]).then(() => true);
    if (!await Promise.race([settled, limit.then(() => false)])) this.log("STOP sending still pending; resetting the plain streams");
    this.plainCut = true;
    // A plain stream cut mid-group must not end with FIN: its header says it holds the group's end.
    await Promise.all([...this.plainStreams.values()].map((p) => this.conn.resetSubgroup(p.stream).catch(() => {})));
    this.plainStreams.clear();
    const ends = [...this.subs.values()].flat().filter((s) => s.ready)
      .map((s) => this.conn.publishDone(s.requestId, PublishDoneCode18.TRACK_ENDED, "publisher stopped").catch(() => {}));
    await Promise.race([Promise.all(ends), new Promise((r) => setTimeout(r, 1000))]);
    await this.closeConn();
  }

  private fatal(why: string): void {
    this.log(why);
    if (this.o.onFatal) this.o.onFatal(why);
  }

  private async onSubscribe(requestId: bigint, name: string, params?: Map<bigint, unknown[]>): Promise<void> {
    const list = this.subs.get(name);
    if (!list) {
      await this.conn.rejectSubscribe(requestId, RequestError18.DOES_NOT_EXIST, `no track ${name}`)
        .catch((e) => this.log(`rejectSubscribe ${name}: ${(e as Error).message}`));
      this.log(`SUBSCRIBE ${name} (${requestId}) refused`);
      return;
    }
    let filter;
    try {
      filter = requestedFilter(params);
    } catch (e) {
      await this.conn.rejectSubscribe(requestId, RequestError18.INVALID_RANGE, `bad filter: ${(e as Error).message}`)
        .catch(() => {});
      this.log(`SUBSCRIBE ${name} (${requestId}) refused: ${(e as Error).message}`);
      return;
    }
    // The window is fixed by the Largest Object reported now. Registered before SUBSCRIBE_OK goes
    // out, so an UNSUBSCRIBE in the meantime finds it; objects go to it only once it is ready, so
    // any sent while SUBSCRIBE_OK is being written are not sent to it.
    const largest = this.largest.get(name)!.value;
    const s: Sub = { requestId, alias: this.nextAlias++, ready: false, window: filterWindow(filter, largest),
      absolute: filter?.type === "AbsoluteStart" || filter?.type === "AbsoluteRange", fromBlock: 0 };
    list.push(s);
    try {
      await this.conn.acceptSubscribe(requestId, s.alias, { parameters: subscribeOkParams(largest) });
    } catch (e) {
      this.forget(list, s);
      this.log(`SUBSCRIBE ${name} (${requestId}) failed: ${(e as Error).message}`);
      return;
    }
    if (!list.includes(s)) { this.log(`SUBSCRIBE ${name} (${requestId}) closed before SUBSCRIBE_OK went out`); return; }
    // A datagram track's window would open just after its Largest Object, mid-block. Unless the filter
    // names a start Location, it opens at the next block whose source hasn't started, on `src` and on
    // every rung alike: a subscriber gets each block's source and repair whole from its first block.
    const datagrams = name !== CATALOG_TRACK && name !== this.o.plain;
    if (datagrams && !s.absolute) s.fromBlock = this.sourceBlock + 1;
    s.ready = true;
    this.log(`SUBSCRIBED ${name} request ${requestId} alias ${s.alias} filter ${describeFilter(filter)} `
      + `largest ${largest ? `${largest.group}.${largest.object}` : "none"} from ${s.window.start.group}.${s.window.start.object}`
      + (datagrams && !s.absolute ? ` block ${s.fromBlock}` : ""));
    if (name === CATALOG_TRACK) await this.sendCatalogTo(s, this.nextCatalogGroup());
  }

  private forget(list: Sub[], s: Sub): void {
    const i = list.indexOf(s);
    if (i >= 0) list.splice(i, 1);
  }

  private onSubscribeClosed(requestId: bigint): void {
    for (const [name, list] of this.subs) {
      const s = list.find((x) => x.requestId === requestId);
      if (s) { this.forget(list, s); this.plainStreams.delete(s); this.log(`UNSUBSCRIBED ${name} request ${requestId}`); }
    }
  }

  private failed(track: string, n: TrackCounters, what: string): void {
    n.failed++;
    const now = performance.now();
    const f = this.failLog.get(track);
    if (f && now - f.at < FAIL_LOG_MS) { f.since++; return; }
    this.log(`${track}: ${what}${f ? ` (${f.since} more failures since the last report)` : ""}; ${n.failed} in all`);
    this.failLog.set(track, { at: now, since: 0 });
  }

  private async sendCatalog(): Promise<void> {
    const subs = this.subs.get(CATALOG_TRACK)!.filter((s) => s.ready);
    if (subs.length === 0) return;
    const group = this.nextCatalogGroup();
    await Promise.all(subs.map((s) => this.sendCatalogTo(s, group)));
  }

  private nextCatalogGroup(): bigint {
    const g = this.catalogGroup++;
    this.largest.get(CATALOG_TRACK)!.note(g, 0);
    return g;
  }

  /** One catalog object as the whole group: object 0 on subgroup 0, END_OF_GROUP, then FIN. */
  private async sendCatalogTo(s: Sub, group: bigint): Promise<void> {
    const n = this.counters.get(CATALOG_TRACK)!;
    if (!admits(s.window, group, 0)) return;
    try {
      const stream = await this.conn.openSubgroup(s.alias, group, 0n, {
        requestId: s.requestId, endOfGroup: true, defaultPriority: true,
        subgroupIdMode: SubgroupIdMode.ZERO, firstObject: true,
      });
      await this.conn.sendObject(stream, 0n, this.o.catalog);
      await this.conn.closeSubgroup(stream);
      n.sent++;
    } catch (e) {
      this.failed(CATALOG_TRACK, n, `group ${group}: ${(e as Error).message}`);
    }
  }

  private async send(d: Datagram, b: number): Promise<void> {
    const n = this.counters.get(d.track)!;
    // A dropped datagram stands for loss on the wire: the track has still sent it.
    this.largest.get(d.track)!.note(d.group, d.object);
    if (this.o.drop?.(d)) { n.dropped++; return; }
    // A copy: a subscription can close while a datagram is being written.
    for (const s of [...this.subs.get(d.track)!]) {
      if (!s.ready || b < s.fromBlock || !admits(s.window, d.group, d.object)) continue;
      try {
        await this.conn.sendDatagram(s.alias, BigInt(d.group), BigInt(d.object), d.payload, { requestId: s.requestId });
        n.sent++;
      } catch (e) {
        this.failed(d.track, n, `datagram ${d.group}.${d.object}: ${(e as Error).message}`);
      }
    }
  }

  private async runBlocks(): Promise<void> {
    const { media, rungs } = this.o;
    const gapMs = media.gapS * 1000;
    const tStart = performance.now();
    const t0Us = Math.trunc(Date.now() * 1000);
    const lateMs = this.o.lateMs ?? LATE_MS;
    for (let b = 0; !this.stopped && (this.o.blocks === undefined || b < this.o.blocks); b++) {
      const slot = tStart + b * gapMs;
      await until(slot);
      if (this.stopped) break;
      const late = performance.now() - slot;
      this.blocksStarted.all++;
      this.blocksStarted.maxLateMs = Math.max(this.blocksStarted.maxLateMs, Math.round(late));
      if (late > lateMs) {
        this.blocksStarted.late++;
        this.log(`LATE block ${b}: source starts ${Math.round(late)} ms after its slot`);
      }
      // The plain track's objects go out at the block's slot too, on their own queue: a slow
      // stream doesn't hold up the datagrams.
      if (this.o.plain) {
        const objs = plainObjects(media, b, t0Us);
        this.plainQueue = this.plainQueue.then(() => this.sendPlain(objs));
      }
      await this.sendBlock(b, media.objects(b, t0Us), rungs, gapMs);
    }
    await Promise.all(this.repairQueues.values());
  }

  /**
   * A block of the plain track to each subscriber: a subgroup stream per group, opened at the group's
   * first object (FIRST_OBJECT set) and ended with FIN after its last (the header's END_OF_GROUP bit
   * set). A subscriber joins at a group start, so a player starts at a key frame, unless its filter
   * names a start Location inside a group.
   */
  private async sendPlain(objs: PlainObject[]): Promise<void> {
    const name = this.o.plain!;
    const n = this.counters.get(name)!;
    for (const o of objs) {
      if (this.plainCut) return;
      this.largest.get(name)!.note(o.group, o.object);
      for (const s of [...this.subs.get(name)!]) {
        if (!s.ready || !admits(s.window, o.group, o.object)) continue;
        let p = this.plainStreams.get(s);
        try {
          if (!p) {
            const atStart = s.absolute && BigInt(o.group) === s.window.start.group && BigInt(o.object) === s.window.start.object;
            if (!o.groupStart && !atStart) continue;
            const stream = await this.conn.openSubgroup(s.alias, BigInt(o.group), 0n, {
              requestId: s.requestId, endOfGroup: true, hasExtensions: true, defaultPriority: true,
              subgroupIdMode: SubgroupIdMode.ZERO, firstObject: o.groupStart,
            });
            // Closed, or stop() gave up waiting, while the stream was being opened.
            if (this.plainCut || !this.subs.get(name)!.includes(s)) {
              void this.conn.resetSubgroup(stream).catch(() => {});
              continue;
            }
            p = { group: o.group, stream };
            this.plainStreams.set(s, p);
          }
          await this.conn.sendObject(p.stream, BigInt(o.object), o.payload, o.properties);
          n.sent++;
          if (o.groupEnd) {
            this.plainStreams.delete(s);
            await this.conn.closeSubgroup(p.stream);
          }
        } catch (e) {
          this.failed(name, n, `object ${o.group}.${o.object}: ${(e as Error).message}`);
          if (p) { this.plainStreams.delete(s); void this.conn.resetSubgroup(p.stream).catch(() => {}); }
        }
      }
    }
  }

  /**
   * Block b's source (--pace-source: spread over that fraction of the block period), then its repair
   * is encoded and handed to each rung's queue. Paced (--pace-repair), each rung's repair for the block
   * is spread over that fraction of the block period from when the rung starts it, behind the rung's
   * earlier blocks, so the rungs interleave by slot and a slow rung delays only itself, not the next
   * block's source. Unpaced, the rungs go back to back in rung order on one queue.
   */
  private async sendBlock(b: number, objects: Uint8Array[], rungs: number[], gapMs: number): Promise<void> {
    const { paceSource = 0, paceRepair = 0, media } = this.o;
    const k = layoutBlock(objects.map((o) => o.length)).k;
    const repair = new Map<string, Datagram[]>();
    const t0 = performance.now();
    this.sourceBlock = b;
    let j = 0;
    for (const d of blockDatagrams(b, objects, rungs, media.blocksPerGroup)) {
      if (d.track === SOURCE_TRACK) {
        if (paceSource) await until(t0 + j * paceSource * gapMs / k);
        await this.send(d, b);
        j++;
      } else {
        if (!repair.has(d.track)) repair.set(d.track, []);
        repair.get(d.track)!.push(d);
      }
    }
    for (const [track, list] of repair) {
      const key = paceRepair ? track : "repair";
      const prev = this.repairQueues.get(key) ?? Promise.resolve();
      this.repairQueues.set(key, prev.then(() => this.sendRepair(b, list, paceRepair * gapMs))
        .catch((e: unknown) => this.fatal(`${track} block ${b}: ${(e as Error).stack ?? e}`)));
    }
  }

  /** One rung's repair for one block, spread over spanMs from now (0: back to back). */
  private async sendRepair(b: number, list: Datagram[], spanMs: number): Promise<void> {
    const tRel = performance.now();
    for (const [n, d] of list.entries()) {
      if (this.stopped) return;
      if (spanMs) await until(tRel + n * spanMs / list.length);
      await this.send(d, b);
    }
  }

  summary(): string {
    const { all, late, maxLateMs } = this.blocksStarted;
    return `blocks ${all} late ${late} (max ${maxLateMs} ms after the slot); ` + this.tracks.map((t) => {
      const c = this.counters.get(t)!;
      return `${t} sent ${c.sent} dropped ${c.dropped} failed ${c.failed} subs ${this.subs.get(t)!.length}`;
    }).join("; ");
  }

  /** The session's QUIC datagram counters: what "sent" above handed to QUIC that never left or was lost. */
  async quicSummary(): Promise<string> {
    const d = await this.datagramStats();
    return d ? `quic datagrams expired ${d.expiredOutgoing} lost ${d.lostOutgoing}` : "quic datagram stats unavailable";
  }
}
