// The datagrams of one block for the three-track catalog's FEC tracks: `src` carries one plain
// repair-format object per source symbol, `rep<r>` the rung's slice of the global repair symbols
// (moq.py's DatagramSourceTrack and repair rungs, through web/fec-decoder's schedule). Source first,
// then each rung in order: written in this order to one datagram queue, a block's repair stays
// behind its source, and the source leaves before the repair is encoded.

import { encode, MAX_N } from "fec-decoder/src/encoder.ts";
import { layoutBlock, toSymbols, SYMBOL_SIZE } from "fec-decoder/src/layout.ts";
import { DATAGRAM_MAX_PAYLOAD } from "fec-decoder/src/wire.ts";
import { repairObjects, repairTrackName, rungSlices, sourceObjects,
  type TrackObject } from "fec-decoder/src/schedule.ts";

export const SOURCE_TRACK = "src";

export interface Datagram extends TrackObject { track: string }

/**
 * Block b's datagrams: its source, then its repair. A generator, so the repair is encoded (`enc`)
 * only when the consumer asks for the datagram after the last source one: a sender that awaits each
 * send has all the source out before encoding starts.
 */
export function* blockDatagrams(b: number, objects: Uint8Array[], rungFracs: number[], blocksPerGroup = 1,
                                enc = encode): Generator<Datagram> {
  for (const o of sourceObjects(b, objects, blocksPerGroup)) yield { track: SOURCE_TRACK, ...o };
  if (rungFracs.length === 0) return;
  const sizes = objects.map((o) => o.length);
  const lay = layoutBlock(sizes, SYMBOL_SIZE);
  const slices = rungSlices(lay.k, rungFracs);
  const repair = enc(toSymbols(lay, objects), slices[slices.length - 1].stop);
  for (const [r, s] of slices.entries()) {
    const track = repairTrackName(r + 1);
    for (const o of repairObjects(b, s, sizes, repair, blocksPerGroup)) yield { track, ...o };
  }
}

/** The largest repair-format payload of a block of n objects (codec, count, n sizes, symbol). */
export function maxPayload(n: number): number {
  return 2 + 2 * n + SYMBOL_SIZE;
}

/**
 * What would stop a block mid-run, checked before any is sent: an object over the u16 size field,
 * a payload over the datagram ceiling, more
 * symbols than GF(2^8) (and the q * 256 + j stride) allows. One line per problem block.
 */
export function blockLimitErrors(blocks: Uint8Array[][], rungFracs: number[]): string[] {
  const errs: string[] = [];
  blocks.forEach((objects, b) => {
    const big = objects.map((o, i) => [i, o.length]).filter(([, n]) => n > 0xffff);
    if (big.length) errs.push(`block ${b}: object(s) ${big.map(([i, n]) => `${i} (${n} B)`).join(", ")} over 65535 B`);
    if (maxPayload(objects.length) > DATAGRAM_MAX_PAYLOAD) {
      errs.push(`block ${b}: ${objects.length} objects make a ${maxPayload(objects.length)} B datagram payload, `
        + `over ${DATAGRAM_MAX_PAYLOAD} B`);
    }
    if (big.length) return;
    const k = layoutBlock(objects.map((o) => o.length), SYMBOL_SIZE).k;
    const m = rungFracs.length ? rungSlices(k, rungFracs).at(-1)!.stop : 0;
    if (k + m > MAX_N) errs.push(`block ${b}: k ${k} + m ${m} = ${k + m} symbols, over ${MAX_N}`);
  });
  return errs;
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
