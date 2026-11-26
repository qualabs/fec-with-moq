// The datagrams of one block for the three-track catalog's FEC tracks: `src` carries one plain
// repair-format object per source symbol, `rep<r>` the rung's slice of the global repair symbols
// (moq.py's DatagramSourceTrack and repair rungs, through web/fec-decoder's schedule). Source first,
// then each rung in order: written in this order to one datagram queue, a block's repair stays
// behind its source.

import { encode } from "fec-decoder/src/encoder.ts";
import { layoutBlock, toSymbols, SYMBOL_SIZE } from "fec-decoder/src/layout.ts";
import { repairObjects, repairTrackName, rungSlices, sourceObjects, type TrackObject } from "fec-decoder/src/schedule.ts";

export const SOURCE_TRACK = "src";

export interface Datagram extends TrackObject { track: string }

export function blockDatagrams(b: number, objects: Uint8Array[], rungFracs: number[],
                               blocksPerGroup = 1): Datagram[] {
  const out: Datagram[] = sourceObjects(b, objects, blocksPerGroup).map((o) => ({ track: SOURCE_TRACK, ...o }));
  if (rungFracs.length === 0) return out;
  const sizes = objects.map((o) => o.length);
  const lay = layoutBlock(sizes, SYMBOL_SIZE);
  const slices = rungSlices(lay.k, rungFracs);
  const repair = encode(toSymbols(lay, objects), slices[slices.length - 1].stop);
  slices.forEach((s, r) => {
    const track = repairTrackName(r + 1);
    for (const o of repairObjects(b, s, sizes, repair, blocksPerGroup)) out.push({ track, ...o });
  });
  return out;
}

/** mulberry32: a seeded PRNG, so a loss pattern can be replayed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Simulated loss on the publisher: drop each `src` datagram with probability p (repair is never dropped). */
export function sourceDropper(p: number, seed: number): (d: Datagram) => boolean {
  const r = rng(seed);
  return (d) => d.track === SOURCE_TRACK && p > 0 && r() < p;
}
