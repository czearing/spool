/**
 * Approvals and unresolved counts, as the dashboard reports them.
 *
 * These two numbers are the ones a person looks at to decide whether a pull request needs them, so
 * a wrong count is worse than no count.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { approvalSummary } from "../lib/merge-readiness.mjs";
import { renderDashboard } from "../lib/dashboard.mjs";

test("both approval votes count as approvals", () => {
  const summary = approvalSummary({
    reviewers: [
      { displayName: "A", vote: 10 },
      { displayName: "B", vote: 5 },
      { displayName: "C", vote: 0 },
    ],
  });
  assert.equal(summary.approvals, 2);
  assert.equal(summary.reviewers, 3);
  assert.equal(summary.rejections, 0);
  assert.deepEqual(summary.approvers, ["A", "B"]);
});

test("a rejection is reported alongside the approvals rather than hidden", () => {
  const summary = approvalSummary({ reviewers: [{ displayName: "A", vote: 10 }, { displayName: "B", vote: -10 }] });
  assert.equal(summary.approvals, 1);
  assert.equal(summary.reviewers, 2);
  assert.equal(summary.rejections, 1);
  assert.equal(summary.label, "1 approved, 1 blocking");
});

test("a reviewer group does not inflate the approval count", () => {
  const summary = approvalSummary({
    reviewers: [{ displayName: "Team", vote: 10, isContainer: true }, { displayName: "A", vote: 10 }],
  });
  assert.equal(summary.approvals, 1);
  assert.equal(summary.reviewers, 1);
});

test("a pull request nobody has voted on has no approvals", () => {
  assert.equal(approvalSummary({ reviewers: [] }).approvals, 0);
  assert.equal(approvalSummary({ reviewers: [] }).reviewers, 0);
  assert.equal(approvalSummary({}).approvals, 0);
  assert.equal(approvalSummary({}).reviewers, 0);
});

test("the watch table shows approvals with assigned reviewers and unresolved counts", () => {
  const html = renderDashboard({
    status: {
      open: 1,
      actionable: 0,
      pullRequests: [{
        id: "5622136",
        title: "Composer",
        url: "https://example/pr",
        branch: "user/caleb/x",
        build: { state: "passed", label: "5/5 passed" },
        approvals: 2,
        reviewers: 3,
        approvalLabel: "2",
        unresolved: 4,
        unresolvedHuman: 0,
        unresolvedAutomated: 4,
        mergeStatus: "succeeded",
      }],
    },
    jobs: [],
    summary: { running: 0, done: 0, failed: 0, stalled: 0 },
  });

  assert.ok(html.includes("<th>Approvals</th>"));
  assert.ok(html.includes("<th>Unresolved</th>"));
  assert.ok(html.includes(">2/3</td>"), "the approvals / assigned reviewers count is rendered");
  assert.ok(html.includes(">4</td>"), "the unresolved count is rendered");
});

test("unresolved human feedback is called out separately from pipeline chatter", () => {
  const html = renderDashboard({
    status: {
      open: 1,
      actionable: 1,
      pullRequests: [{
        id: "1", title: "t", url: "u", branch: "b",
        build: { state: "passed", label: "ok" },
        approvals: 2, approvalLabel: "2", unresolved: 3, unresolvedHuman: 1, unresolvedAutomated: 2,
        mergeStatus: "succeeded",
      }],
    },
    jobs: [],
    summary: { running: 0, done: 0, failed: 0, stalled: 0 },
  });

  assert.ok(html.includes("3 (1 human)"));
  assert.ok(html.includes("warn"), "a person waiting is highlighted");
});

test("the headline says why nothing is being dispatched", () => {
  const html = renderDashboard({
    status: { open: 2, actionable: 1, holding: "pr-updater is working on dashboard-message", pullRequests: [] },
    jobs: [],
    summary: { running: 0, done: 0, failed: 0, stalled: 0 },
  });
  assert.ok(html.includes("Holding: pr-updater is working on dashboard-message"));
});
