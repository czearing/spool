/**
 * Merge readiness and the build column.
 *
 * The interesting cases are the ones where a pull request looks finished and is not: no gate at
 * all, no approval, or a verdict still outstanding. Reporting one of those as ready would send a
 * person to click merge on something that cannot land.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSummary, readyToMerge } from "../lib/merge-readiness.mjs";

const green = [
  { id: 1, name: "CI Build", result: "succeeded" },
  { id: 2, name: "Compliance", result: "succeeded" },
];
const approvedPr = { mergeStatus: "succeeded", isDraft: false, votes: [10] };

test("confirmed infrastructure blockage is neither passing nor a code failure", () => {
  const blocked = { id: 7, name: "Buddy Build", result: "failed", failureKind: "infrastructure" };
  const summary = buildSummary([blocked]);
  assert.equal(summary.state, "blocked");
  assert.equal(summary.blocked, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.running, 0);
  assert.match(summary.label, /CI infrastructure blocked: Buddy Build/);
  assert.equal(readyToMerge({ pr: approvedPr, builds: [blocked], verdict: null }), false);
  assert.equal(buildSummary([blocked, { id: 8, result: "failed" }]).state, "failed");
});

test("no builds reads as none rather than passing", () => {
  const summary = buildSummary([]);
  assert.equal(summary.state, "none");
  assert.equal(summary.label, "no builds");
});

test("a failing build names itself so the row is actionable", () => {
  const summary = buildSummary([...green, { id: 3, name: "Buddy Build", result: "failed" }]);
  assert.equal(summary.state, "failed");
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failing, ["Buddy Build"]);
  assert.ok(summary.label.includes("Buddy Build"));
});

test("an unfinished build counts as running, not passed", () => {
  const summary = buildSummary([...green, { id: 3, name: "Live Tests", result: null }]);
  assert.equal(summary.state, "running");
  assert.equal(summary.running, 1);
  assert.equal(summary.passed, 2);
});

test("all green with an approval is ready to merge", () => {
  assert.equal(readyToMerge({ pr: approvedPr, builds: green, verdict: null }), true);
});

test("a green gate with no builds at all is not ready", () => {
  assert.equal(readyToMerge({ pr: approvedPr, builds: [], verdict: null }), false);
});

test("no approval is not ready even when everything passed", () => {
  assert.equal(readyToMerge({ pr: { ...approvedPr, votes: [0] }, builds: green, verdict: null }), false);
});

test("a rejection blocks readiness", () => {
  assert.equal(readyToMerge({ pr: { ...approvedPr, votes: [10, -10] }, builds: green, verdict: null }), false);
});

test("an outstanding verdict blocks readiness", () => {
  assert.equal(readyToMerge({ pr: approvedPr, builds: green, verdict: { trigger: "review" } }), false);
});

test("a conflicted pull request is never ready", () => {
  assert.equal(readyToMerge({ pr: { ...approvedPr, mergeStatus: "conflicts" }, builds: green, verdict: null }), false);
});
