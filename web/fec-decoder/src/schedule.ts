// Block schedule of src/fecmoq/moq.py (rung_slices, BlockSchedule.address and repair_address) for
// the three-track catalog's mapping: source symbols and repair on datagrams, global repair ids, a
// MoQ group of blocksPerGroup blocks, symbol j of the group's q-th block is Object q * OBJECT_STRIDE + j.

import { layoutBlock, toSymbols } from "./layout.ts";
import { packRepairObject } from "./wire.ts";

/** moq.OBJECT_STRIDE: the object ids of one block within a group of several. */
export const OBJECT_STRIDE = 256;

/** A Python range: start inclusive, stop exclusive. */
export interface Slice { start: number; stop: number }

/** (group, object, starts a group), as BlockSchedule.address returns. */
export type Address = [group: number, object: number, groupStart: boolean];

export interface TrackObject { group: number; object: number; groupStart: boolean; payload: Uint8Array }

/** Python 3 round() on a float: ties go to the even integer. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x), d = x - f;
  return d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
}

/** moq.rung_slices: each rung's global repair indices, additive and consecutive, at least one each. */
export function rungSlices(k: number, rungFracs: number[]): Slice[] {
  let start = 0;
  return rungFracs.map((f) => {
    const s = { start, stop: start + Math.max(1, roundHalfEven(k * f)) };
    start = s.stop;
    return s;
  });
}

export function repairTrackName(rung: number): string {
  return `rep${rung}`;
}

function check(name: string, v: number, min = 0): void {
  if (!Number.isInteger(v) || v < min) throw new RangeError(`${name} must be an integer >= ${min}; got ${v}`);
}

/** BlockSchedule.address: symbol j of block b, source or repair (j = global repair index). */
export function address(b: number, j: number, blocksPerGroup = 1): Address {
  check("block", b);
  check("symbol index", j);
  check("blocksPerGroup", blocksPerGroup, 1);
  if (blocksPerGroup === 1) return [b, j, j === 0];
  if (j >= OBJECT_STRIDE) throw new RangeError(`symbol index ${j} >= ${OBJECT_STRIDE} collides with the next block`);
  const q = b % blocksPerGroup;
  return [Math.floor(b / blocksPerGroup), q * OBJECT_STRIDE + j, q === 0 && j === 0];
}

/** BlockSchedule.repair_address: a rung's n-th symbol, global index j; every rung opens each group. */
export function repairAddress(b: number, n: number, j: number, blocksPerGroup = 1): Address {
  check("rung position", n);
  const [g, o] = address(b, j, blocksPerGroup);
  return [g, o, n === 0 && b % blocksPerGroup === 0];
}

/** Mp4Gops' cut: whole GOPs of `gop` items, each starting on a key item, in blocks of n; the tail is dropped. */
export function cutBlocks<T>(items: T[], isKey: (item: T) => boolean, n: number,
                             gop = n): { blocks: T[][]; blocksPerGroup: number } {
  check("n", n, 1);
  check("gop", gop, 1);
  if (gop % n) throw new RangeError(`GOP of ${gop} frames is not a whole number of ${n}-frame blocks`);
  if (items.length < gop) throw new RangeError(`${items.length} frames, fewer than one GOP of ${gop}`);
  const whole = items.length - (items.length % gop);
  for (let i = 0; i < whole; i += gop) {
    if (!isKey(items[i])) throw new RangeError(`GOP ${i / gop} doesn't start on a keyframe; encode with keyint=${gop}`);
  }
  const blocks: T[][] = [];
  for (let i = 0; i < whole; i += n) blocks.push(items.slice(i, i + n));
  return { blocks, blocksPerGroup: gop / n };
}

/** What the datagram source track writes for block b: one plain repair-format object per source symbol. */
export function sourceObjects(b: number, objects: Uint8Array[], blocksPerGroup = 1): TrackObject[] {
  const sizes = objects.map((o) => o.length);
  return toSymbols(layoutBlock(sizes), objects).map((sym, j) => {
    const [group, object, groupStart] = address(b, j, blocksPerGroup);
    return { group, object, groupStart, payload: packRepairObject(sizes, sym) };
  });
}

/** What a repair rung's track writes for block b: repair[j] for each j of its slice, object id from j. */
export function repairObjects(b: number, slice: Slice, sizes: number[], repair: Uint8Array[],
                              blocksPerGroup = 1): TrackObject[] {
  const out: TrackObject[] = [];
  for (let j = slice.start; j < slice.stop; j++) {
    const [group, object, groupStart] = repairAddress(b, j - slice.start, j, blocksPerGroup);
    out.push({ group, object, groupStart, payload: packRepairObject(sizes, repair[j]) });
  }
  return out;
}
