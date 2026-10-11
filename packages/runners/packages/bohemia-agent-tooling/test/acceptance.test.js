import test from "node:test";
import assert from "node:assert/strict";
import { checkAcceptance, readAfterNumber } from "../src/acceptance.js";

const task = { issueId: "i1", metric: "demo.metric", current: 1000, acceptance: 800 };

test("the after number is read from the issue body or a comment", () => {
  assert.equal(readAfterNumber("metric: demo\nafter: 742"), 742);
  assert.equal(readAfterNumber(["no number here", "After: 640.5"]), 640.5);
  assert.equal(readAfterNumber("the work is done"), null);
});

test("an open issue is pending and produces no transition", () => {
  const result = checkAcceptance(task, { status: "in_progress", description: "metric: demo" });
  assert.equal(result.transition, "open");
  assert.equal(result.verdict, "pending");
});

test("a closed issue with an after number at or below acceptance is met", () => {
  const result = checkAcceptance(task, { status: "done", description: "metric: demo" }, [{ body: "after: 780" }]);
  assert.equal(result.verdict, "met");
  assert.equal(result.after, 780);
  assert.equal(result.delta, -220);
});

test("a closed issue with an after number above acceptance is not met", () => {
  const result = checkAcceptance(task, { status: "done", description: "after: 900" });
  assert.equal(result.verdict, "not_met");
  assert.equal(result.after, 900);
});

test("a higher is better task inverts the comparison", () => {
  const rate = { issueId: "i2", metric: "demo.rate", current: 40, acceptance: 60, direction: "higher_is_better" };
  assert.equal(checkAcceptance(rate, { status: "done", description: "after: 61" }).verdict, "met");
  assert.equal(checkAcceptance(rate, { status: "done", description: "after: 59" }).verdict, "not_met");
});

test("a closed issue with no after number is recorded rather than guessed", () => {
  const result = checkAcceptance(task, { status: "done", description: "fixed it" });
  assert.equal(result.verdict, "no_after_number");
  assert.equal(result.after, null);
});

test("a cancelled issue closes the task without a verdict on the number", () => {
  const result = checkAcceptance(task, { status: "cancelled", description: "not needed" });
  assert.equal(result.transition, "closed");
  assert.equal(result.verdict, "cancelled");
});

test("a missing issue is reported as missing rather than treated as met", () => {
  const result = checkAcceptance(task, null);
  assert.equal(result.verdict, "unknown");
  assert.equal(result.transition, "missing");
});
