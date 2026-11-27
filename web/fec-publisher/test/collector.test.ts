// Which blocks subscribe-check counts after a late join.
//
//   node --test test/collector.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { countedBlocks, joinAbandoned, type Arrival, type PlayerBlock } from "../src/collector.ts";

const span = (track: string, from: number, to: number, at: number): Arrival[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ track, block: from + i, at }));

test("rungs that start groups after src: counting starts where every track has delivered", () => {
  // src from block 34 (before the last SUBSCRIBE_OK at t=10), the rungs from block 36
  const arrivals = [...span("src", 34, 34, 5), ...span("src", 35, 40, 20), ...span("rep1", 36, 40, 20), ...span("rep2", 37, 40, 20)];
  assert.deepEqual(countedBlocks(arrivals, ["src", "rep1", "rep2"], 10), [37, 38, 39]);
});

test("every track from the same block: after the blocks seen before SUBSCRIBE_OK", () => {
  const arrivals = [...span("src", 10, 11, 5), ...span("rep1", 10, 11, 5), ...span("src", 12, 15, 20), ...span("rep1", 12, 15, 20)];
  assert.deepEqual(countedBlocks(arrivals, ["src", "rep1"], 10), [12, 13, 14]);
});

test("a block missing on one track after the join is still counted", () => {
  const arrivals = [...span("src", 5, 9, 20), ...span("rep1", 5, 6, 20), ...span("rep1", 8, 9, 20)];
  assert.deepEqual(countedBlocks(arrivals, ["src", "rep1"], 10), [6, 7, 8]);
});

test("a track that delivered nothing: no block is counted", () => {
  assert.deepEqual(countedBlocks(span("src", 1, 9, 20), ["src", "rep1"], 10), []);
});

const log = (...o: [number, PlayerBlock["outcome"]][]): PlayerBlock[] => o.map(([id, outcome]) => ({ id, outcome }));

test("player: the abandoned block before the first whole or recovered one is the join", () => {
  assert.deepEqual(joinAbandoned(log([20, "abandoned"], [21, "recovered"], [22, "whole"])), [20]);
});

test("player: an abandoned block after the first whole or recovered one is not the join", () => {
  assert.deepEqual(joinAbandoned(log([20, "whole"], [21, "abandoned"], [22, "recovered"])), []);
  assert.deepEqual(joinAbandoned(log([20, "abandoned"], [21, "whole"], [30, "abandoned"])), [20]);
});

test("player: no whole or recovered block, no join", () => {
  assert.deepEqual(joinAbandoned(log([20, "abandoned"], [21, "abandoned"])), []);
});
