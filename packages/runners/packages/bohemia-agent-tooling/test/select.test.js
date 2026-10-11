import test from "node:test";
import assert from "node:assert/strict";
import { defineThresholdSelector, defineOpenCapSelector, gapRatio, assertSelector } from "../src/select.js";

function observation(metric, current, target, extra = {}) {
  return {
    metric,
    current,
    target,
    acceptance: target,
    unit: "bytes",
    reproduction: `node measure.js ${metric}`,
    ...extra,
  };
}

test("the gap ratio measures how far a number sits on the wrong side of its target", () => {
  assert.equal(gapRatio(observation("a", 120, 100)), 0.2);
  assert.equal(gapRatio(observation("b", 80, 100)), -0.2);
  assert.equal(gapRatio(observation("c", 80, 100, { direction: "higher_is_better" })), 0.2);
});

test("the selector picks the largest gap above the threshold", () => {
  const select = defineThresholdSelector({ minGapRatio: 0.1 });
  const result = select([observation("a", 115, 100), observation("b", 150, 100), observation("c", 101, 100)]);
  assert.equal(result.candidate.metric, "b");
  assert.equal(result.reason, "largest_gap_above_threshold");
  assert.equal(result.considered, 3);
});

test("no candidate above the threshold is a normal result, not an error", () => {
  const select = defineThresholdSelector({ minGapRatio: 0.5 });
  const result = select([observation("a", 115, 100), observation("b", 90, 100)]);
  assert.equal(result.candidate, null);
  assert.equal(result.reason, "no_observation_cleared_threshold");
  assert.equal(result.minGapRatio, 0.5);
});

test("an empty observation set selects nothing", () => {
  const select = defineThresholdSelector({ minGapRatio: 0.1 });
  assert.equal(select([]).candidate, null);
});

test("excluded metrics are never selected", () => {
  const select = defineThresholdSelector({
    minGapRatio: 0.1,
    excludeMetrics: (o) => o.metric === "b",
  });
  assert.equal(select([observation("a", 115, 100), observation("b", 150, 100)]).candidate.metric, "a");
});

test("a selector must be a function and a bad threshold is refused", () => {
  assert.throws(() => defineThresholdSelector({ minGapRatio: "high" }), /finite number/);
  assert.throws(() => assertSelector({}), /selector must be a function/);
});

test("the open cap refuses a candidate once the queue is full and keeps the ranking", () => {
  let open = 0;
  const selector = defineOpenCapSelector({
    selector: defineThresholdSelector({ minGapRatio: 0.1 }),
    countOpen: () => open,
    maxOpenTasks: 1,
  });
  const observations = [
    { metric: "a", current: 150, target: 100, acceptance: 100, unit: "n", reproduction: "node m.js" },
  ];

  const free = selector(observations);
  assert.equal(free.candidate.metric, "a");
  assert.equal(free.openTasks, 0);

  open = 1;
  const full = selector(observations);
  assert.equal(full.candidate, null);
  assert.equal(full.reason, "max_open_tasks_reached");
  assert.equal(full.maxOpenTasks, 1);

  open = 0;
  const freed = selector(observations);
  assert.equal(freed.candidate.metric, "a", "a task that closed frees its slot in the same run");
});

test("the open cap refuses a bad configuration rather than guessing one", () => {
  const selector = defineThresholdSelector({});
  assert.throws(() => defineOpenCapSelector({ selector, countOpen: () => 0, maxOpenTasks: 0 }), /at least 1/);
  assert.throws(() => defineOpenCapSelector({ selector, countOpen: null, maxOpenTasks: 1 }), /countOpen/);
});
