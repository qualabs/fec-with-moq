// The receiving end of the FEC tracks, for checks: source and repair datagrams gathered per block
// (inverse of BlockSchedule.address), then each block rebuilt with web/fec-decoder.

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
