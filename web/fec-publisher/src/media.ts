// media.py's MediaBlockSchedule for the datagram tracks: an mp4's frames cut into blocks of n
// (cutBlocks), each frame a source object `props_len:u16 | LOC properties | payload`, the properties
// in the draft-18 encoding (the LOC timestamp, µs since the Unix epoch). Block b loops the clip and
// is stamped t0 + b * gap + i * gap / n, so the timeline runs at the block rate.

import { encodePropertyBlock } from "@openmoq/transport";
import { cutBlocks } from "fec-decoder/src/schedule.ts";
import type { CatalogMedia } from "fec-decoder/src/catalog.ts";
import type { Sample, VideoTrack } from "./mp4.ts";

export const LOC_PROP_TIMESTAMP = 0x10n;
const MAX_OBJECT = 0xffff;

export function locProperties(timestampUs: number): Uint8Array {
  return encodePropertyBlock([{ id: LOC_PROP_TIMESTAMP, value: BigInt(timestampUs) }], "d18-delta-vi64");
}

export function packLocObject(props: Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + props.length + payload.length);
  if (out.length > MAX_OBJECT) throw new RangeError(`LOC object ${out.length} B exceeds ${MAX_OBJECT} B`);
  out[0] = props.length >> 8;
  out[1] = props.length & 0xff;
  out.set(props, 2);
  out.set(payload, 2 + props.length);
  return out;
}

export function unpackLocObject(o: Uint8Array): { props: Uint8Array; payload: Uint8Array } {
  const n = (o[0] << 8) | o[1];
  return { props: o.subarray(2, 2 + n), payload: o.subarray(2 + n) };
}

export class MediaBlocks {
  readonly track: VideoTrack;
  readonly n: number;
  readonly gapS: number;
  readonly blocks: Sample[][];
  readonly blocksPerGroup: number;

  constructor(track: VideoTrack, n: number, gapS: number, gop = n) {
    this.track = track;
    this.n = n;
    this.gapS = gapS;
    const cut = cutBlocks(track.samples, (s) => s.key, n, gop);
    this.blocks = cut.blocks;
    this.blocksPerGroup = cut.blocksPerGroup;
  }

  /** What catalogJson needs: the frame sizes of the whole GOPs, as Mp4Gops.sizes. */
  catalogMedia(): CatalogMedia {
    return {
      codec: this.track.codec, width: this.track.width, height: this.track.height,
      blocksPerGop: this.blocksPerGroup, sizes: this.blocks.flat().map((s) => s.payload.length),
    };
  }

  /** Block b's frame payloads, the clip looping. */
  payloads(b: number): Uint8Array[] {
    return this.blocks[b % this.blocks.length].map((s) => s.payload);
  }

  /** Block b's frames and their LOC timestamps, stamped from t0Us: what the source objects and the plain track carry. */
  frames(b: number, t0Us: number): { timestampUs: number; payload: Uint8Array }[] {
    const gapUs = this.gapS * 1e6, frameUs = gapUs / this.n;
    return this.payloads(b).map((payload, i) => ({ timestampUs: t0Us + Math.trunc(b * gapUs + i * frameUs), payload }));
  }

  /** Block b's source objects, stamped from t0Us. */
  objects(b: number, t0Us: number): Uint8Array[] {
    return this.frames(b, t0Us).map((f) => packLocObject(locProperties(f.timestampUs), f.payload));
  }
}
