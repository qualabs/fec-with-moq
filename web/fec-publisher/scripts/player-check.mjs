// Marc's Playa FEC test page (examples/fec-with-moq/index.html of moq-playa branch fec-with-moq-v2),
// headless in the system Chrome, for SECS seconds; prints the page's record (state, frames, gaps, FEC
// counters) with the checks below, and exits 1 if one fails: at least --min-frames frames decoded (1);
// with the FEC stage on, at most --max-abandoned blocks (0) abandoned or missing, at any loss; with
// --drop-src P > 0 (the loss the publisher was started with) also source lost and blocks recovered.
// --demo opens demo.html instead (Playa's default catalogBootstrap, no cb) and reads
// the player's stats and fecStats() from it. Playwright comes from the Playa checkout
// (PLAYA=/path/to/moq-playa, after its pnpm install).
//
//   PLAYA=... node scripts/player-check.mjs --page http://127.0.0.1:8283 --url URL --ns NS --hash HEX
//     [--fec 3] [--cb subscribe|auto] [--demo] [--drop-src P] [--max-abandoned N] [--min-frames N] [--secs 30]
//     [--log warn] [--console 15] [--chrome /usr/bin/google-chrome]

import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    page: { type: "string" }, url: { type: "string" }, ns: { type: "string" }, hash: { type: "string" },
    fec: { type: "string", default: "3" }, cb: { type: "string", default: "subscribe" },
    secs: { type: "string", default: "30" }, log: { type: "string", default: "warn" },
    chrome: { type: "string", default: "/usr/bin/google-chrome" },
    demo: { type: "boolean", default: false }, "drop-src": { type: "string", default: "0" },
    "max-abandoned": { type: "string", default: "0" }, "min-frames": { type: "string", default: "1" },
    console: { type: "string", default: "15" },
  },
});
if (!process.env.PLAYA || !a.page || !a.url || !a.ns) {
  console.error("usage: PLAYA=/path/to/moq-playa node scripts/player-check.mjs --page http://127.0.0.1:PORT --url URL --ns NS [--hash HEX] [--fec N|''] [--cb subscribe] [--secs S]");
  process.exit(2);
}
const { chromium } = createRequire(`${process.env.PLAYA}/package.json`)("playwright");

const q = a.demo
  ? new URLSearchParams({ url: a.url, ns: a.ns, ver: "draft-18", log: a.log, fec: a.fec ? "1" : "0", rungs: a.fec || "0" })
  : new URLSearchParams({ url: a.url, ns: a.ns, v: "18", log: a.log, cb: a.cb });
if (a.hash) q.set(a.demo ? "certHash" : "hash", a.hash);
if (a.fec) q.set("deadline", "600");
if (!a.demo && a.fec) q.set("fec", a.fec);
const browser = await chromium.launch({ executablePath: a.chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => consoleLines.push(`pageerror: ${String(e).slice(0, 300)}`));
await page.goto(`${a.page}/fec-with-moq/${a.demo ? "demo" : "index"}.html?${q}`);
await new Promise((r) => setTimeout(r, Number(a.secs) * 1000));
// demo.html keeps no playaRun: the same fields from the Player, fecStats() and demoLog
const run = await page.evaluate(() => window.playaRun ?? {
  state: window.playaPlayer?.state, stats: [{ ...window.playaPlayer?.stats }],
  fec: window.fecStage ? { ...window.fecStats(), blockLog: window.fecStage.blockLog } : null,
  errors: (window.demoLog ?? []).filter((l) => /error|FAILED|unhandled/i.test(l)), demoLog: (window.demoLog ?? []).slice(-15),
});
await browser.close();

const stats = run?.stats ?? [];
const last = stats.at(-1) ?? {};
const draws = (run?.frames ?? []).map((f) => f[0]);
const gaps = draws.slice(1).map((t, i) => t - draws[i]);
const fec = run?.fec;
const keep = ["blocksSeen", "blocksWhole", "blocksRecovered", "blocksAbandoned", "blocksMissing", "blocksSkipped",
  "framesReleased", "framesDropped", "sourceSymbols", "sourceLost", "repairSymbols", "decodeCount", "decodeFailures"];
const drop = Number(a["drop-src"]), maxAbandoned = Number(a["max-abandoned"]), minFrames = Number(a["min-frames"]);
const checks = [[`framesDecoded >= ${minFrames}`, (last.framesDecoded ?? 0) >= minFrames]];
if (a.fec !== "") {
  checks.push([`fec.blocksAbandoned + fec.blocksMissing <= ${maxAbandoned}`,
    fec != null && (fec.blocksAbandoned ?? 0) + (fec.blocksMissing ?? 0) <= maxAbandoned]);
}
if (drop > 0) {
  checks.push(["fec.sourceLost > 0", (fec?.sourceLost ?? 0) > 0], ["fec.blocksRecovered > 0", (fec?.blocksRecovered ?? 0) > 0]);
}
const failed = checks.filter(([, ok]) => !ok).map(([c]) => c);
console.log(JSON.stringify({
  page: a.demo ? "demo.html" : `index.html cb=${a.cb}`, ok: failed.length === 0, failed,
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
  demoLog: run?.demoLog,
  console: consoleLines.slice(-Number(a.console)),
}, null, 1));
process.exit(failed.length ? 1 : 0);
