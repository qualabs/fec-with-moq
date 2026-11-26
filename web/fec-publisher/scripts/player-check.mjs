// Marc's Playa FEC test page (examples/fec-with-moq/index.html of moq-playa branch fec-with-moq-v2),
// headless in the system Chrome, for SECS seconds; prints the summary playa_play.py prints, trimmed.
// Playwright comes from the Playa checkout (PLAYA=/path/to/moq-playa, after its pnpm install).
//
//   PLAYA=... node scripts/player-check.mjs --page http://127.0.0.1:8283 --url URL --ns NS --hash HEX
//     [--fec 3] [--cb subscribe] [--secs 30] [--chrome /usr/bin/google-chrome]

import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    page: { type: "string" }, url: { type: "string" }, ns: { type: "string" }, hash: { type: "string" },
    fec: { type: "string", default: "3" }, cb: { type: "string", default: "subscribe" },
    secs: { type: "string", default: "30" }, log: { type: "string", default: "warn" },
    chrome: { type: "string", default: "/usr/bin/google-chrome" },
  },
});
if (!process.env.PLAYA || !a.page || !a.url || !a.ns) {
  console.error("usage: PLAYA=/path/to/moq-playa node scripts/player-check.mjs --page http://127.0.0.1:PORT --url URL --ns NS [--hash HEX] [--fec N|''] [--cb subscribe] [--secs S]");
  process.exit(2);
}
const { chromium } = createRequire(`${process.env.PLAYA}/package.json`)("playwright");

const q = new URLSearchParams({ url: a.url, ns: a.ns, v: "18", log: a.log, cb: a.cb });
if (a.hash) q.set("hash", a.hash);
if (a.fec) { q.set("fec", a.fec); q.set("deadline", "600"); }
const browser = await chromium.launch({ executablePath: a.chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => consoleLines.push(`pageerror: ${String(e).slice(0, 300)}`));
await page.goto(`${a.page}/fec-with-moq/index.html?${q}`);
await new Promise((r) => setTimeout(r, Number(a.secs) * 1000));
const run = await page.evaluate(() => window.playaRun);
await browser.close();

const stats = run?.stats ?? [];
const last = stats.at(-1) ?? {};
const draws = (run?.frames ?? []).map((f) => f[0]);
const gaps = draws.slice(1).map((t, i) => t - draws[i]);
const fec = run?.fec;
const keep = ["blocksSeen", "blocksWhole", "blocksRecovered", "blocksAbandoned", "blocksMissing", "blocksSkipped",
  "framesReleased", "framesDropped", "sourceSymbols", "sourceLost", "repairSymbols", "decodeCount", "decodeFailures"];
console.log(JSON.stringify({
  protocol: (run?.webtransport ?? []).map((w) => w.protocol),
  wtErrors: (run?.webtransport ?? []).map((w) => w.error).filter(Boolean),
  state: run?.state,
  firstFrameMs: stats.find((s) => (s.framesDecoded ?? 0) > 0)?.atMs ?? null,
  framesDecoded: last.framesDecoded, framesRendered: last.framesRendered, framesDropped: last.framesDropped,
  stallCount: last.stallCount, videoCodec: last.videoCodec, resolution: last.resolution,
  frameDraws: draws.length, maxGapMs: Math.round(Math.max(0, ...gaps)), gapsOver100ms: gaps.filter((g) => g > 100).length,
  errors: run?.errors,
  fec: fec ? Object.fromEntries(keep.map((k) => [k, fec[k]])) : null,
  fecNotWhole: (fec?.blockLog ?? []).filter((b) => b.outcome !== "whole" && b.outcome !== "recovered").slice(0, 10),
  firstDrawAtMs: draws[0] ?? null,
  gapsOver100msAt: draws.slice(1).map((t, i) => [Math.round(draws[i]), Math.round(t - draws[i])]).filter(([, g]) => g > 100),
  console: consoleLines.slice(-15),
}, null, 1));
