import test from "node:test";
import assert from "node:assert/strict";

import { analyzeWakePaths } from "../src/wake-paths.js";

const readers = {
  idOf: (row) => row.id,
  dependsOnOf: (row) => row.waitsOn ?? [],
  isParked: (row) => row.parked === true,
  hasOwnWakePath: (row) => row.parked !== true || row.timer === true,
};

function analyze(rows) {
  return analyzeWakePaths(rows, readers);
}

test("a parked row waiting on something live is not stranded", () => {
  const result = analyze([
    { id: "a", parked: true, waitsOn: ["b"] },
    { id: "b", parked: false },
  ]);
  assert.equal(result.strandedCount, 0);
  assert.equal(result.deadEndCount, 0);
  assert.equal(result.chainTerminalCount, 0);
});

test("a parked row with nothing to wait on and no timer is a dead end", () => {
  const result = analyze([{ id: "a", parked: true }]);
  assert.equal(result.deadEndCount, 1);
  assert.equal(result.strandedCount, 1);
  assert.equal(result.chainTerminalCount, 0, "nothing waits on it, so it strands only itself");
  assert.equal(result.strandedDependentCount, 0);
});

test("a parked row with a timer of its own is not a dead end", () => {
  const result = analyze([{ id: "a", parked: true, timer: true }]);
  assert.equal(result.deadEndCount, 0);
  assert.equal(result.strandedCount, 0);
});

test("a dead end something waits on is a chain terminal and the waiters are counted behind it", () => {
  const result = analyze([
    { id: "top", parked: true, waitsOn: ["middle"] },
    { id: "middle", parked: true, waitsOn: ["dead"] },
    { id: "dead", parked: true },
    { id: "elsewhere", parked: true },
  ]);
  assert.equal(result.deadEndCount, 2, "the dead end and the unrelated parked row both qualify");
  assert.equal(result.chainTerminalCount, 1);
  assert.equal(result.chainTerminals[0].id, "dead");
  assert.deepEqual(result.chainTerminals[0].strandedDependentIds, ["middle", "top"]);
  assert.equal(result.strandedCount, 4);
  assert.deepEqual(result.strandedDependentIds, ["middle", "top"]);
});

test("a waiter is only stranded when every path out of it is dead", () => {
  const result = analyze([
    { id: "waiter", parked: true, waitsOn: ["dead", "live"] },
    { id: "dead", parked: true },
    { id: "live", parked: false },
  ]);
  assert.equal(result.chainTerminalCount, 1, "the dead end is still a terminal");
  assert.deepEqual(result.chainTerminals[0].strandedDependentIds, []);
  assert.deepEqual(result.strandedIds, ["dead"]);
  assert.equal(result.strandedDependentCount, 0);
});

test("a dependency outside the read is credited rather than accused, and reported", () => {
  const result = analyze([{ id: "a", parked: true, waitsOn: ["missing"] }]);
  assert.equal(result.unresolvedDependencies, 1);
  assert.equal(result.deadEndCount, 0);
  assert.equal(result.strandedCount, 0);
});

test("a waiting cycle grants no wake path and is reported rather than spinning", () => {
  const result = analyze([
    { id: "a", parked: true, waitsOn: ["b"] },
    { id: "b", parked: true, waitsOn: ["a"] },
  ]);
  assert.deepEqual(result.strandedIds, ["a", "b"]);
  assert.equal(result.cyclicIds.length > 0, true);
  assert.equal(result.deadEndCount, 0, "each row has something to wait on, so neither is a dead end");
});

test("a self reference and a repeated edge do not change the reading", () => {
  const result = analyze([
    { id: "a", parked: true, waitsOn: ["a", "b", "b"] },
    { id: "b", parked: true },
  ]);
  assert.equal(result.chainTerminalCount, 1);
  assert.deepEqual(result.chainTerminals[0].strandedDependentIds, ["a"]);
  assert.equal(result.unresolvedDependencies, 0);
});

test("a duplicate row identity is read once", () => {
  const result = analyze([
    { id: "a", parked: true },
    { id: "a", parked: true },
  ]);
  assert.equal(result.rowCount, 1);
  assert.equal(result.deadEndCount, 1);
});

test("the walk refuses to guess what parked or waking mean", () => {
  assert.throws(() => analyzeWakePaths([], {}), /idOf/);
  assert.throws(() => analyzeWakePaths([], { idOf: (row) => row.id }), /isParked/);
  assert.throws(
    () => analyzeWakePaths([], { idOf: (row) => row.id, isParked: () => false }),
    /hasOwnWakePath/,
  );
});

test("two walks over the same rows return the same numbers", () => {
  const rows = [
    { id: "top", parked: true, waitsOn: ["dead"] },
    { id: "dead", parked: true },
  ];
  assert.deepEqual(analyze(rows), analyze(rows));
});
