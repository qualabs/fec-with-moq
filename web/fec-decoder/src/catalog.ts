// The three-track MSF catalog (draft-02) and its exact bytes: a plain LOC track, the x-fec-source
// track and the x-fec-repair rungs, the FEC parameters in packagingMetadata.

import { roundHalfEven } from "./schedule.ts";

export interface CatalogMedia {
  codec: string;
  width: number;
  height: number;
  blocksPerGop: number;
  sizes: number[];
}

export interface CatalogOptions {
  nObjects: number;
  gapS: number;
  rungs: number[];
  symbolSize: number;
  source?: string;
  objectStride?: number;
  plain?: string | null;
  generatedAt?: number;
}

export type CatalogTrack = Record<string, unknown> & { name: string; packaging: string; isLive: boolean };

export interface Catalog {
  version: "draft-02";
  generatedAt: number;
  tracks: CatalogTrack[];
}

// Fields written as floats: 60.0, not 60.
const FLOAT_KEYS = new Set(["framerate", "blockSeconds", "rungFractions"]);

export function catalog(media: CatalogMedia, o: CatalogOptions): Catalog {
  const { nObjects, gapS, rungs, symbolSize, source = "src", objectStride = 256, plain = "video" } = o;
  const rungNames = rungs.map((_, r) => `rep${r + 1}`);
  const fps = roundHalfEvenTo(nObjects / gapS, 3);
  const fec = {
    scheme: "rs-cauchy-gf256", codec: 2, symbolSize, blockObjects: nObjects, blockSeconds: gapS, rungs: rungNames,
    rungFractions: [...rungs], objectFormat: "props_len:u16|properties|payload",
    blocksPerGroup: media.blocksPerGop, objectStride,
  };
  const meta: Record<string, string | number> = {
    scheme: "rs-cauchy-gf256", symbolSize, blockObjects: nObjects, blockSeconds: formatG(gapS),
    blocksPerGroup: media.blocksPerGop, objectStride, rungs: rungs.length,
  };
  if (plain) meta.plainTrack = plain;
  const tracks: CatalogTrack[] = [];
  if (plain) {
    tracks.push({
      name: plain, packaging: "loc", isLive: true, role: "video", renderGroup: 1, codec: media.codec, framerate: fps,
      bitrate: peakBitrate(media.sizes, fps), width: media.width, height: media.height,
    });
  }
  tracks.push({ name: source, packaging: "x-fec-source", isLive: true, packagingMetadata: packagingMetadata(meta), "x-fec": fec });
  rungNames.forEach((name, i) => tracks.push({
    name, packaging: "x-fec-repair", isLive: true,
    packagingMetadata: packagingMetadata({ source, rung: i + 1, fraction: formatG(rungs[i]) }),
    "x-fec": { source, rung: i + 1 },
  }));
  return { version: "draft-02", generatedAt: o.generatedAt ?? Date.now(), tracks };
}

/** The catalog's bytes, as toCatalogJson writes them. */
export function catalogJson(media: CatalogMedia, o: CatalogOptions): Uint8Array {
  return new TextEncoder().encode(toCatalogJson(catalog(media, o)));
}

/** The most bits in any round(fps) consecutive frames, the clip looping. */
export function peakBitrate(sizes: number[], fps: number): number {
  const w = Math.max(1, roundHalfEven(fps));
  const loop = [...sizes, ...sizes.slice(0, w - 1)];
  let cur = loop.slice(0, w).reduce((a, b) => a + b, 0), best = cur;
  for (let i = w; i < loop.length; i++) best = Math.max(best, (cur += loop[i] - loop[i - w]));
  return best * 8;
}

/** MSF-02 §5.2.5: key=value pairs joined by ';'; whitespace, '=' or ';' throw. */
export function packagingMetadata(kv: Record<string, string | number>): string {
  return Object.entries(kv).map(([k, v]) => {
    if (/[ \t\n=;]/.test(k + v)) throw new RangeError(`packagingMetadata ${k}=${v}: whitespace, '=' or ';'`);
    return `${k}=${v}`;
  }).join(";");
}

/** The inverse; the first occurrence of a key wins. */
export function parsePackagingMetadata(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0 && !(pair.slice(0, eq) in out)) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

// The exact binary value is rounded half to even; toFixed and toExponential round a tie up. A tie
// is exact in 100 digits: its digits past `cut` are 5 then zeros.
function tieToEven(digits: string, cut: number): boolean {
  return /^50*$/.test(digits.slice(cut)) && Number(digits[cut - 1]) % 2 === 0;
}

/** x rounded to nd >= 1 decimals, half to even on its exact binary value. */
export function roundHalfEvenTo(x: number, nd: number): number {
  const s = Math.abs(x).toFixed(100), dot = s.indexOf(".");
  const digits = s.slice(0, dot) + s.slice(dot + 1);
  return tieToEven(digits, dot + nd) ? Math.sign(x) * Number(s.slice(0, dot + 1 + nd)) : Number(x.toFixed(nd));
}

/** printf's %g: 6 significant digits, trailing zeros dropped, exponent outside 1e-4 .. 1e6. */
export function formatG(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`formatG: ${x}`);
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const [exact, exactE] = Math.abs(x).toExponential(100).split("e");
  const [m, e] = tieToEven(exact.replace(".", ""), 6) ? [exact.slice(0, 7), exactE] : Math.abs(x).toExponential(5).split("e");
  return (x < 0 ? "-" : "") + placeDigits(m.replace(".", "").replace(/0+$/, ""), Number(e), -4, 6, "");
}

/** A float field: the shortest round-trip digits, "60.0" for a whole number, exponent outside 1e-4 .. 1e16. */
export function formatJsonFloat(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`formatJsonFloat: ${x}`);
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [m, e] = Math.abs(x).toExponential().split("e");
  return (x < 0 ? "-" : "") + placeDigits(m.replace(".", ""), Number(e), -4, 16, ".0");
}

// Significant digits d.ddd × 10^e, fixed when lo <= e < hi (`whole` after an integer), else d.ddde±XX.
function placeDigits(d: string, e: number, lo: number, hi: number, whole: string): string {
  if (e < lo || e >= hi) {
    const exp = `e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
    return d[0] + (d.length > 1 ? "." + d.slice(1) : "") + exp;
  }
  if (e < 0) return "0." + "0".repeat(-e - 1) + d;
  const int = d.slice(0, e + 1).padEnd(e + 1, "0"), frac = d.slice(e + 1);
  return frac ? `${int}.${frac}` : int + whole;
}

/** The catalog's JSON: ", " and ": " separators, non-ASCII as \uXXXX, FLOAT_KEYS' values as formatJsonFloat. */
export function toCatalogJson(v: unknown, float = false): string {
  if (typeof v === "number") return float ? formatJsonFloat(v) : String(v);
  if (typeof v === "string") {
    return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  if (Array.isArray(v)) return `[${v.map((x) => toCatalogJson(x, float)).join(", ")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${toCatalogJson(k)}: ${toCatalogJson(x, FLOAT_KEYS.has(k))}`).join(", ")}}`;
  }
  return JSON.stringify(v);
}
