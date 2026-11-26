// The first video track of an mp4 as its samples, the part of aiomoqt's Mp4Reader that
// media.py's Mp4Gops reads: sample bytes, key flags, codec string, size and frame rate.
// AV1 only: its sequence header travels in band, so a LOC frame needs no decoder description.

export interface Sample { payload: Uint8Array; key: boolean }

export interface VideoTrack {
  codec: string;
  width: number;
  height: number;
  fps: number;
  samples: Sample[];
}

interface Box { type: string; start: number; end: number }

function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  for (let p = start; p + 8 <= end;) {
    let size = v.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    let header = 8;
    if (size === 1) { size = Number(v.getBigUint64(p + 8)); header = 16; }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) throw new RangeError(`mp4: bad box ${type} at ${p}`);
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}

function child(b: Uint8Array, parent: Box, type: string): Box | undefined {
  return boxes(b, parent.start, parent.end).find((x) => x.type === type);
}

function path(b: Uint8Array, parent: Box, ...types: string[]): Box {
  let cur = parent;
  for (const t of types) {
    const next = child(b, cur, t);
    if (!next) throw new RangeError(`mp4: no ${t} box`);
    cur = next;
  }
  return cur;
}

/** av1C → `av01.P.LLT.DD` (AV1 codec ISO-BMFF binding §5). */
function av1Codec(c: Uint8Array): string {
  const profile = c[1] >> 5, level = c[1] & 0x1f, tier = c[2] >> 7;
  const high = (c[2] >> 6) & 1, twelve = (c[2] >> 5) & 1;
  const depth = profile === 2 && high ? (twelve ? 12 : 10) : high ? 10 : 8;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier ? "H" : "M"}.${String(depth).padStart(2, "0")}`;
}

export function readVideoTrack(file: Uint8Array): VideoTrack {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const u32 = (p: number) => v.getUint32(p);
  const top = { type: "", start: 0, end: file.length };
  const moov = path(file, top, "moov");
  const trak = boxes(file, moov.start, moov.end).find((t) => {
    if (t.type !== "trak") return false;
    const hdlr = path(file, t, "mdia", "hdlr");
    return String.fromCharCode(...file.subarray(hdlr.start + 8, hdlr.start + 12)) === "vide";
  });
  if (!trak) throw new RangeError("mp4: no video track");
  const mdia = path(file, trak, "mdia");
  const mdhd = path(file, mdia, "mdhd");
  const timescale = file[mdhd.start] === 1 ? u32(mdhd.start + 20) : u32(mdhd.start + 12);
  const stbl = path(file, mdia, "minf", "stbl");

  const stsd = path(file, stbl, "stsd");
  const [entry] = boxes(file, stsd.start + 8, stsd.end);
  if (entry.type !== "av01") throw new RangeError(`mp4: sample entry ${entry.type}, only av01 is supported`);
  const width = v.getUint16(entry.start + 24), height = v.getUint16(entry.start + 26);
  const av1C = boxes(file, entry.start + 78, entry.end).find((x) => x.type === "av1C");
  if (!av1C) throw new RangeError("mp4: av01 without av1C");
  const codec = av1Codec(file.subarray(av1C.start, av1C.end));

  const stsz = path(file, stbl, "stsz");
  const fixed = u32(stsz.start + 4), count = u32(stsz.start + 8);
  const sizes = Array.from({ length: count }, (_, i) => fixed || u32(stsz.start + 12 + 4 * i));

  const co = child(file, stbl, "stco") ?? child(file, stbl, "co64");
  if (!co) throw new RangeError("mp4: no stco/co64");
  const nChunks = u32(co.start + 4);
  const chunkOffsets = Array.from({ length: nChunks }, (_, i) =>
    co.type === "stco" ? u32(co.start + 8 + 4 * i) : Number(v.getBigUint64(co.start + 8 + 8 * i)));

  const stsc = path(file, stbl, "stsc");
  const runs = Array.from({ length: u32(stsc.start + 4) }, (_, i) =>
    ({ first: u32(stsc.start + 8 + 12 * i), perChunk: u32(stsc.start + 12 + 12 * i) }));

  const stss = child(file, stbl, "stss");
  const keys = stss ? new Set(Array.from({ length: u32(stss.start + 4) }, (_, i) => u32(stss.start + 8 + 4 * i) - 1))
    : null;

  const samples: Sample[] = [];
  for (let r = 0; r < runs.length; r++) {
    const last = r + 1 < runs.length ? runs[r + 1].first - 1 : nChunks;
    for (let c = runs[r].first; c <= last; c++) {
      let off = chunkOffsets[c - 1];
      for (let s = 0; s < runs[r].perChunk && samples.length < count; s++) {
        const i = samples.length;
        samples.push({ payload: file.subarray(off, off + sizes[i]), key: keys ? keys.has(i) : true });
        off += sizes[i];
      }
    }
  }

  const stts = path(file, stbl, "stts");
  let duration = 0;
  for (let i = 0, n = u32(stts.start + 4); i < n; i++) duration += u32(stts.start + 8 + 8 * i) * u32(stts.start + 12 + 8 * i);
  const fps = duration ? (count * timescale) / duration : 0;

  return { codec, width, height, fps, samples };
}
