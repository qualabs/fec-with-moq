// The plain track, for players without FEC: the same frames and LOC
// timestamps as the source symbols, one frame per object, the timestamp as the object's property
// (draft-18 encoding) and the frame as its payload. Group = the source's group (a GOP); block b is the
// group's q-th block and its frame i is object q * n + i, so a group's objects are 0 .. GOP - 1.

import { locProperties, type MediaBlocks } from "./media.ts";

export interface PlainObject {
  group: number;
  object: number;
  /** The group's first object: a new subgroup stream opens here. */
  groupStart: boolean;
  /** The group's last object: its stream ends here. */
  groupEnd: boolean;
  properties: Uint8Array;
  payload: Uint8Array;
}

export function plainObjects(media: MediaBlocks, b: number, t0Us: number): PlainObject[] {
  const bpg = media.blocksPerGroup, n = media.n;
  const g = Math.floor(b / bpg), q = b % bpg;
  return media.frames(b, t0Us).map((f, i) => ({
    group: g, object: q * n + i,
    groupStart: q === 0 && i === 0, groupEnd: q === bpg - 1 && i === n - 1,
    properties: locProperties(f.timestampUs), payload: f.payload,
  }));
}
