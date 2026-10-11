import test from "node:test";
import assert from "node:assert/strict";

import { round, summarizeNumbers, percentage, countBy } from "../src/numbers.js";

test("a rounding is fixed by the core so two collectors report the same quantity alike", () => {
  assert.equal(round(3.14159), 3.14);
  assert.equal(round(3.14159, 3), 3.142);
  assert.equal(round(null), null);
  assert.equal(round(Number.NaN), null);
  assert.equal(round(Number.POSITIVE_INFINITY), null);
});

test("an empty list is unknown rather than zero so a clause behind it cannot pass by default", () => {
  const summary = summarizeNumbers([]);
  assert.deepEqual(summary, {
    count: 0,
    missing: 0,
    minimum: null,
    maximum: null,
    mean: null,
    total: null,
  });
});

test("a value the platform does not record is counted as missing rather than read as zero", () => {
  const summary = summarizeNumbers([10, null, 20, undefined, 30, Number.NaN]);
  assert.equal(summary.count, 3);
  assert.equal(summary.missing, 3);
  assert.equal(summary.minimum, 10);
  assert.equal(summary.maximum, 30);
  assert.equal(summary.mean, 20);
  assert.equal(summary.total, 60);
});

test("summarizeNumbers rejects anything that is not an array of values", () => {
  assert.throws(() => summarizeNumbers(null), /requires an array/);
});

test("a whole of zero is unknown rather than zero percent", () => {
  assert.equal(percentage(1, 4), 25);
  assert.equal(percentage(2, 3), 66.7);
  assert.equal(percentage(0, 0), null);
  assert.equal(percentage(1, null), null);
});

test("a key the platform leaves empty is visible as a named group rather than dropped", () => {
  const counts = countBy([{ k: "a" }, { k: null }, { k: "a" }, { k: "" }, { k: "b" }], (r) => r.k, {
    emptyKey: "no recorded outcome",
  });
  assert.deepEqual(counts, [
    { key: "a", count: 2 },
    { key: "no recorded outcome", count: 2 },
    { key: "b", count: 1 },
  ]);
});

test("counts of the same size are ordered by key so two runs return the same list", () => {
  const rows = [{ k: "z" }, { k: "a" }];
  assert.deepEqual(countBy(rows, (r) => r.k), [
    { key: "a", count: 1 },
    { key: "z", count: 1 },
  ]);
});

test("countBy rejects a missing key reader", () => {
  assert.throws(() => countBy([], null), /requires a key reader/);
});
