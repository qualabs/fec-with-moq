// The receiving end of the FEC tracks, for checks: source and repair datagrams gathered per block
// (the inverse of the schedule's address), then each block rebuilt with web/fec-decoder.

import { recoverSymbols } from "fec-decoder/src/decoder.ts";
import { fromSymbols, layoutBlock } from "fec-decoder/src/layout.ts";
import { OBJECT_STRIDE } from "fec-decoder/src/schedule.ts";
import { parseRepairObject } from "fec-decoder/src/wire.ts";
import { SOURCE_TRACK } from "./producer.ts";

interface Pending { sizes: number[]; source: Map<number, Uint8Array>; repair: Map<number, Uint8Array> }

export type BlockOutcome =
  | { block: number; status: "intact" | "recovered"; k: number; source: number; repair: number; objects: Uint8Array[] }
  | { block: number; status: "lost"; k: number; source: number; repair: number; reason: string };

export class BlockCollector {
  private readonly blocks = new Map<number, Pending>();
  private readonly bpg: number;
  malformed = 0;

  constructor(blocksPerGroup = 1) {
    this.bpg = blocksPerGroup;
  }

  add(track: string, group: number, object: number, payload: Uint8Array): void {
    let r;
    try { r = parseRepairObject(payload); } catch { this.malformed++; return; }
    const j = this.bpg === 1 ? object : object % OBJECT_STRIDE;
    const b = this.bpg === 1 ? group : group * this.bpg + Math.floor(object / OBJECT_STRIDE);
    let p = this.blocks.get(b);
    if (!p) this.blocks.set(b, p = { sizes: r.sizes, source: new Map(), repair: new Map() });
    (track === SOURCE_TRACK ? p.source : p.repair).set(j, r.symbol);
  }

  blockIds(): number[] {
    return [...this.blocks.keys()].sort((x, y) => x - y);
  }

  /** Block b's object sizes, from any of its datagrams; undefined if none arrived. */
  sizes(b: number): number[] | undefined {
    return this.blocks.get(b)?.sizes;
  }

  decode(b: number): BlockOutcome {
    const p = this.blocks.get(b);
    if (!p) throw new RangeError(`no datagram of block ${b}`);
    const lay = layoutBlock(p.sizes);
    const base = { block: b, k: lay.k, source: p.source.size, repair: p.repair.size };
    const r = recoverSymbols(lay.k, p.source, p.repair);
    if (!r.ok) return { ...base, status: "lost", reason: r.reason };
    return { ...base, status: p.source.size >= lay.k ? "intact" : "recovered", objects: fromSymbols(lay, r.value) };
  }
}

export interface Arrival { track: string; block: number; at: number }

/**
 * The blocks a late subscriber can judge: from the first block where every one of `tracks` has
 * delivered a datagram (a relay may start one track's subscription groups after another's), and
 * after every block that had a datagram before `ready` (the last SUBSCRIBE_OK, so possibly partial),
 * up to but not including the last block seen (cut by the stop). Empty if a track delivered nothing.
 */
export function countedBlocks(arrivals: Arrival[], tracks: string[], ready: number): number[] {
  const firstOf = new Map<string, number>();
  let beforeReady = -1, firstAfter = Infinity, last = -1;
  for (const { track, block, at } of arrivals) {
    firstOf.set(track, Math.min(firstOf.get(track) ?? Infinity, block));
    if (at < ready) beforeReady = Math.max(beforeReady, block); else firstAfter = Math.min(firstAfter, block);
    last = Math.max(last, block);
  }
  if (tracks.some((t) => !firstOf.has(t))) return [];
  const joined = Math.max(...tracks.map((t) => firstOf.get(t)!));
  const first = Math.max(joined, 1 + (beforeReady >= 0 ? beforeReady : firstAfter));
  return Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i);
}

/**
 * The least last counted block of a subscriber that listened `secs` seconds after `ready`: from the
 * first block that arrived after `ready`, one block per `blockS` seconds, less `slack` of them and
 * three blocks (the one cut by the stop, and two for the timers). Undefined if nothing arrived after
 * `ready`. A last counted block short of it means the tracks stopped arriving before the end.
 */
export function leastLastBlock(arrivals: Arrival[], ready: number, secs: number, blockS: number, slack = 0.05): number | undefined {
  let first = Infinity;
  for (const { block, at } of arrivals) if (at >= ready) first = Math.min(first, block);
  return first === Infinity ? undefined : first + Math.floor(secs / blockS * (1 - slack)) - 3;
}
