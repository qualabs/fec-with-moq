// The publisher's command-line defaults.
//
//   node --test test/options.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "node:util";
import { pacingError, PUBLISHER_OPTIONS } from "../src/options.ts";

test("pacing is on by default, and 0 still turns it off", () => {
  const on = parseArgs({ args: [], options: PUBLISHER_OPTIONS }).values;
  assert.deepEqual([on["pace-source"], on["pace-repair"]], ["0.5", "0.4"]);
  const off = parseArgs({ args: ["--pace-source", "0", "--pace-repair", "0"], options: PUBLISHER_OPTIONS }).values;
  assert.deepEqual([Number(off["pace-source"]), Number(off["pace-repair"])], [0, 0]);
});

test("pacing: the source and the repair fractions must fit in one block period", () => {
  assert.equal(pacingError(0.5, 0.4), undefined);
  assert.equal(pacingError(0, 0), undefined);
  assert.equal(pacingError(0.99, 0), undefined);
  assert.match(pacingError(0.5, 0.5)!, /= 1: must be under 1/);
  assert.match(pacingError(0.6, 0.5)!, /must be under 1/);
  assert.match(pacingError(1, 0)!, /^--pace-source 1: /);
  assert.match(pacingError(0, -0.1)!, /^--pace-repair -0.1: /);
  assert.match(pacingError(Number("x"), 0)!, /^--pace-source NaN: /);
});
