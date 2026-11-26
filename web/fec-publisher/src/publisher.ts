// The FEC publisher's MoQ side: announces the namespace, answers SUBSCRIBE for `catalog`, `src` and
// the repair rungs, sends the catalog as a new group every interval on its own subgroup stream, and
// each block's datagrams at the block rate. FETCH is refused (NOT_SUPPORTED); the plain `video`
// track is in the catalog but not served (DOES_NOT_EXIST), so a stock player can't play it yet.

import { RequestError18, SubgroupIdMode } from "@openmoq/transport";
import type { MoqtConnection } from "@openmoq/webtransport";
import { repairTrackName } from "fec-decoder/src/schedule.ts";
import { connect } from "./connect.ts";
import type { MediaBlocks } from "./media.ts";
import { blockDatagrams, SOURCE_TRACK, type Datagram } from "./producer.ts";

export const CATALOG_TRACK = "catalog";

export interface PublisherOptions {
  url: string;
  certHash?: string;
  namespace: string;
  media: MediaBlocks;
  catalog: Uint8Array;
  rungs: number[];
  catalogIntervalS?: number;
  /** Return true to drop a datagram before it is sent (simulated loss on the publisher). */
  drop?: (d: Datagram) => boolean;
  /** Stop after this many blocks (default: run until stop()). */
  blocks?: number;
  log?: (line: string) => void;
}

interface Sub { requestId: bigint; alias: bigint }

export interface TrackCounters { sent: number; dropped: number; failed: number }

export class FecPublisher {
  readonly counters = new Map<string, TrackCounters>();
  private conn!: MoqtConnection;
  private closeConn: () => Promise<void> = async () => {};
  private readonly subs = new Map<string, Sub[]>();
  private nextAlias = 1n;
  private catalogGroup = 0n;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private readonly log: (line: string) => void;
  private readonly tracks: string[];
  private readonly o: PublisherOptions;
  done: Promise<void> = Promise.resolve();

  constructor(o: PublisherOptions) {
    this.o = o;
    this.log = o.log ?? ((l) => console.log(l));
    this.tracks = [CATALOG_TRACK, SOURCE_TRACK, ...o.rungs.map((_, r) => repairTrackName(r + 1))];
    for (const t of this.tracks) { this.subs.set(t, []); this.counters.set(t, { sent: 0, dropped: 0, failed: 0 }); }
  }

  async start(): Promise<void> {
    const c = await connect(this.o.url, this.o.certHash, (conn) => {
      conn.onSubscribe = (id, _ns, name) => void this.onSubscribe(id, new TextDecoder().decode(name));
      conn.onSubscribeClosed = (id) => this.onSubscribeClosed(id);
      conn.onFetch = (id) => {
        this.log(`FETCH ${id} refused`);
        void conn.rejectFetch(id, RequestError18.NOT_SUPPORTED, "FETCH not served").catch((e) => this.log(`rejectFetch: ${e}`));
      };
      conn.onError = (e) => { if (!this.stopped) this.log(`connection error: ${e.message}`); };
      conn.onClose = (code, reason) => { if (!this.stopped) this.log(`connection closed: ${code} ${reason ?? ""}`); };
    });
    this.conn = c.conn;
    this.closeConn = c.close;
    this.log(`CONNECTED ${this.o.url} draft 18`);
    await this.conn.publishNamespace([new TextEncoder().encode(this.o.namespace)]);
    this.log(`ANNOUNCED ${this.o.namespace}`);
    this.timers.push(setInterval(() => void this.sendCatalog(), (this.o.catalogIntervalS ?? 2) * 1000));
    this.done = this.runBlocks();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    await this.done.catch(() => {});
    await this.closeConn();
  }

  private async onSubscribe(requestId: bigint, name: string): Promise<void> {
    const list = this.subs.get(name);
    try {
      if (!list) {
        await this.conn.rejectSubscribe(requestId, RequestError18.DOES_NOT_EXIST, `no track ${name}`);
        this.log(`SUBSCRIBE ${name} (${requestId}) refused`);
        return;
      }
      const alias = this.nextAlias++;
      await this.conn.acceptSubscribe(requestId, alias);
      list.push({ requestId, alias });
      this.log(`SUBSCRIBED ${name} request ${requestId} alias ${alias}`);
      if (name === CATALOG_TRACK) await this.sendCatalogTo({ requestId, alias }, this.catalogGroup++);
    } catch (e) {
      this.log(`SUBSCRIBE ${name} (${requestId}) failed: ${(e as Error).message}`);
    }
  }

  private onSubscribeClosed(requestId: bigint): void {
    for (const [name, list] of this.subs) {
      const i = list.findIndex((s) => s.requestId === requestId);
      if (i >= 0) { list.splice(i, 1); this.log(`UNSUBSCRIBED ${name} request ${requestId}`); }
    }
  }

  private async sendCatalog(): Promise<void> {
    const subs = this.subs.get(CATALOG_TRACK)!;
    if (subs.length === 0) return;
    const group = this.catalogGroup++;
    await Promise.all(subs.map((s) => this.sendCatalogTo(s, group)));
  }

  /** One catalog object as the whole group: object 0 on subgroup 0, END_OF_GROUP, then FIN. */
  private async sendCatalogTo(s: Sub, group: bigint): Promise<void> {
    const n = this.counters.get(CATALOG_TRACK)!;
    try {
      const stream = await this.conn.openSubgroup(s.alias, group, 0n, {
        requestId: s.requestId, endOfGroup: true, defaultPriority: true,
        subgroupIdMode: SubgroupIdMode.ZERO, firstObject: true,
      });
      await this.conn.sendObject(stream, 0n, this.o.catalog);
      await this.conn.closeSubgroup(stream);
      n.sent++;
    } catch (e) {
      n.failed++;
      this.log(`catalog group ${group}: ${(e as Error).message}`);
    }
  }

  private async runBlocks(): Promise<void> {
    const { media, rungs, drop } = this.o;
    const gapMs = media.gapS * 1000;
    const tStart = performance.now();
    const t0Us = Math.trunc(Date.now() * 1000);
    for (let b = 0; !this.stopped && (this.o.blocks === undefined || b < this.o.blocks); b++) {
      const wait = tStart + b * gapMs - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (this.stopped) break;
      for (const d of blockDatagrams(b, media.objects(b, t0Us), rungs, media.blocksPerGroup)) {
        const subs = this.subs.get(d.track)!;
        const n = this.counters.get(d.track)!;
        if (drop?.(d)) { n.dropped++; continue; }
        for (const s of subs) {
          try {
            await this.conn.sendDatagram(s.alias, BigInt(d.group), BigInt(d.object), d.payload, { requestId: s.requestId });
            n.sent++;
          } catch (e) {
            if (n.failed++ === 0) this.log(`${d.track} datagram: ${(e as Error).message}`);
          }
        }
      }
    }
  }

  summary(): string {
    return this.tracks.map((t) => {
      const c = this.counters.get(t)!;
      return `${t} sent ${c.sent} dropped ${c.dropped} failed ${c.failed} subs ${this.subs.get(t)!.length}`;
    }).join("; ");
  }
}
