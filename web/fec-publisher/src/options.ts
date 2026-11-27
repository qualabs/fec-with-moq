// The publisher's command-line options (src/cli.ts). Pacing is on by default: back to back, FAILS
// loses datagrams at a realistic bitrate (README, "Pacing").

export const PUBLISHER_OPTIONS = {
  url: { type: "string" }, hash: { type: "string" }, ns: { type: "string" }, media: { type: "string" },
  objects: { type: "string", default: "12" }, gap: { type: "string", default: "0.2" },
  "gop-frames": { type: "string" }, rungs: { type: "string", default: "0.15,0.15,0.15" },
  "drop-src": { type: "string", default: "0" }, seed: { type: "string", default: "7" },
  secs: { type: "string" }, "catalog-interval": { type: "string", default: "2" },
  "plain-track": { type: "string", default: "video" },
  "pace-source": { type: "string", default: "0.5" }, "pace-repair": { type: "string", default: "0.4" },
} as const;

/**
 * Why --pace-source / --pace-repair can't be used, or undefined. Each is a fraction of the block period
 * in [0, 1); together under 1, so a block's source and its slowest rung's repair fit in one period.
 */
export function pacingError(source: number, repair: number): string | undefined {
  for (const [name, v] of [["--pace-source", source], ["--pace-repair", repair]] as const) {
    if (!Number.isFinite(v) || v < 0 || v >= 1) return `${name} ${v}: a fraction of the block period, at least 0 and under 1`;
  }
  if (source + repair >= 1) return `--pace-source ${source} + --pace-repair ${repair} = ${source + repair}: must be under 1`;
}
