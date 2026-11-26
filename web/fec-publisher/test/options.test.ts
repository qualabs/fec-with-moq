// The publisher's command-line defaults.
//
//   node --test test/options.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "node:util";
import { PUBLISHER_OPTIONS } from "../src/options.ts";

test("pacing is on by default, and 0 still turns it off", () => {
  const on = parseArgs({ args: [], options: PUBLISHER_OPTIONS }).values;
  assert.deepEqual([on["pace-source"], on["pace-repair"]], ["0.5", "0.4"]);
  const off = parseArgs({ args: ["--pace-source", "0", "--pace-repair", "0"], options: PUBLISHER_OPTIONS }).values;
  assert.deepEqual([Number(off["pace-source"]), Number(off["pace-repair"])], [0, 0]);
});
