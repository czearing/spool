import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatAgentBranch, createHandoffLedger, handoffFailures, handoffRollup } from "../../../packages/bohemia-agent-tooling/src/index.js";
import { assignIncident, incidentBranch, submissionId, taskTitle } from "../lib/delivery.mjs";
import { alertDue, recordAssignedAlert } from "../lib/alert-policy.mjs";

const config = {
  agentId: "39d687a2-ff09-4d29-9f2e-a657f95f26ee",
  agentName: "SoftwareEngineer 2",
  projectId: "269f39d3-07e0-426c-90e8-c7c3d1406102",
  priority: "high",
};

const assessment = {
  kind: "regression",
  key: "regression:8228:e2e-failure",
  summary: "@fluidx/html-canvas-container test:e2e failed",
  build: {
    id: "54613526",
    number: "20260902.1",
    url: "https://dev.azure.com/office/OC/_build/results?buildId=54613526",
    sourceBranch: "refs/heads/master",
    sourceVersion: "abcdef123456",
  },
};

test("creates stable submission IDs", () => {
  const id = submissionId(config, assessment, 1);
  assert.match(id, /^livesite:[a-f0-9]{64}:1$/);
  assert.equal(id, submissionId(config, assessment, 1));
});

test("incident identities and branches retain differences beyond human-title truncation", () => {
  const first = { ...assessment, key: "flaky:" + "x".repeat(150) + ":first", summary: "Rotating test failures: " + "same".repeat(40) };
  const second = { ...first, key: "flaky:" + "x".repeat(150) + ":second" };
  assert.notEqual(submissionId(config, first), submissionId(config, second));
  assert.notEqual(submissionId(config, { ...first, key: "a/b" }), submissionId(config, { ...first, key: "ab" }));
  assert.notEqual(formatAgentBranch(incidentBranch(config, first)), formatAgentBranch(incidentBranch(config, second)));
  assert.notEqual(incidentBranch(config, first, 1), incidentBranch(config, first, 2));
  assert.notEqual(incidentBranch(config, first), incidentBranch({ ...config, projectId: "other" }, first));
  assert.ok(incidentBranch(config, first, 123456).length <= 50);
  assert.throws(() => submissionId(config, { key: "" }), /evidence key/);
  assert.throws(() => submissionId(config, first, 0), /positive integer/);
});

test("formats task title within budget", () => {
  const title = taskTitle(assessment, 80);
  assert.equal(title, "[Livesite] regression: @fluidx/html-canvas-container test:e2e failed");

  const longTitle = taskTitle({
    kind: "regression",
    summary: "a".repeat(120),
  }, 40);
  assert.equal(longTitle.length, 40);
  assert.ok(longTitle.endsWith("…"));
});

test("assigns incident to the queue and records handed transition in ledger", async () => {
  let createdIssue = null;
  const mockQueue = {
    async createIssue(issue) {
      createdIssue = issue;
      return { id: "issue-123", identifier: "OFF-200", ...issue };
    },
  };
  const recorded = [];
  const mockLedger = {
    append(transition, record) {
      recorded.push({ transition, ...record });
    },
  };

  const result = await assignIncident(config, assessment, 1, {
    queue: mockQueue,
    ledger: mockLedger,
  });

  assert.equal(result.id, "issue-123");
  assert.equal(createdIssue.assigneeAgentId, config.agentId);
  assert.equal(createdIssue.projectId, config.projectId);
  assert.equal(createdIssue.priority, "high");
  assert.equal(createdIssue.status, "todo");
  assert.match(createdIssue.title, /^\[Livesite\] regression:/);
  assert.match(createdIssue.description, /Livesite incident: regression/);
  assert.match(createdIssue.description, /Build 20260902\.1 \(54613526\)/);

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].transition, "handed");
  assert.equal(recorded[0].taskKey, submissionId(config, assessment, 1));
  assert.equal(recorded[0].agent, "SoftwareEngineer 2");
  assert.equal(recorded[0].issueId, "issue-123");
});

test("prepares dependencies before delivering workspace instructions", async () => {
  let createdIssue = null;
  const repoRoot = "C:\\isolated-fixture\\livesite-agent";
  const existenceChecks = [];
  const preparations = [];
  const mockQueue = {
    async listIssues() { return []; },
    async listLiveRuns() { return []; },
    async createIssue(issue) {
      createdIssue = issue;
      return { id: "issue-123", identifier: "OFF-200", ...issue };
    },
  };

  await assignIncident(
    { ...config, repoRoot },
    assessment,
    1,
    {
      queue: mockQueue,
      workspaceExists(root) {
        existenceChecks.push(root);
        return true;
      },
      async setupAgentBranch(options) {
        preparations.push(options);
        return { branch: formatAgentBranch(options.branch) };
      },
    },
  );

  assert.deepEqual(existenceChecks, []);
  assert.deepEqual(preparations, [{
    repoRoot,
    branch: incidentBranch(config, assessment, 1),
    baseBranch: "master",
    runSetup: true,
    runBuild: false,
  }]);
  const expectedBranch = formatAgentBranch(incidentBranch(config, assessment, 1));
  assert.ok(createdIssue.description.includes(
    `The branch \`${expectedBranch}\` is checked out in \`${repoRoot}\` and verified clean.`,
  ));
  assert.match(createdIssue.description, /Do not run git checkout, fetch, reset, or clean; proceed directly to investigating the incident\./);
});

test("missing configured workspace prevents handoff", async () => {
  let createdIssue;
  let preparations = 0;
  await assert.rejects(assignIncident({ ...config, repoRoot: "C:\\isolated-fixture\\missing" }, assessment, 1, {
    queue: { async listIssues() { return []; }, async listLiveRuns() { return []; }, async createIssue(issue) { createdIssue = issue; return issue; } },
    workspaceExists: () => false,
    async setupAgentBranch() { preparations++; throw new Error("Checkout does not exist"); },
  }), /does not exist/);
  assert.equal(preparations, 1);
  assert.equal(createdIssue, undefined);
});

test("preparation failure blocks incident delivery", async () => {
  let createdIssue;
  let preparations = 0;
  await assert.rejects(assignIncident({ ...config, repoRoot: "C:\\isolated-fixture\\offline" }, assessment, 1, {
    queue: { async listIssues() { return []; }, async listLiveRuns() { return []; }, async createIssue(issue) { createdIssue = issue; return issue; } },
    workspaceExists: () => true,
    async setupAgentBranch() { preparations++; throw new Error("offline fixture"); },
  }), /offline fixture/);
  assert.equal(preparations, 1);
  assert.equal(createdIssue, undefined);
});

test("records refusal in ledger when queue throws", async () => {
  const mockQueue = {
    async createIssue() {
      throw new Error("Network timeout");
    },
  };
  const recorded = [];
  const mockLedger = {
    append(transition, record) {
      recorded.push({ transition, ...record });
    },
  };

  await assert.rejects(
    assignIncident(config, assessment, 1, {
      queue: mockQueue,
      ledger: mockLedger,
    }),
    /Network timeout/,
  );

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].transition, "refused");
  assert.equal(recorded[0].taskKey, submissionId(config, assessment, 1));
  assert.equal(recorded[0].detail, "Network timeout");
});

test("busy workspace uses the real shared held transition without preparing or assigning", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "livesite-held-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = createHandoffLedger({ path: path.join(directory, "handoffs.jsonl"), tool: "livesite" });
  const issue = await assignIncident({ ...config, repoRoot: directory }, assessment, 1, {
    ledger,
    queue: {
      async listIssues() { return [{ assigneeAgentId: config.agentId, status: "in_progress" }]; },
      async createIssue() { assert.fail("busy workspace cannot be assigned"); },
    },
    async setupAgentBranch() { assert.fail("busy workspace cannot be prepared"); },
  });
  assert.equal(issue, null);
  const [held] = handoffRollup(ledger.read());
  assert.equal(held.transition, "held");
  assert.equal(held.handedAt, null);
  assert.deepEqual(handoffFailures(ledger.read()), []);
});

test("only a confirmed incident assignment advances its alert cooldown", () => {
  const state = { alerts: {} };
  const receipt = { now: new Date(), attempt: 1, submissionId: "fixture", issue: null };
  assert.equal(recordAssignedAlert(state, assessment.key, receipt), false);
  assert.deepEqual(state.alerts, {});
  assert.equal(alertDue(state, assessment, receipt.now, 24), true);
  assert.throws(() => recordAssignedAlert(state, assessment.key, { ...receipt, issue: {} }), /confirmed issue/);
  assert.equal(recordAssignedAlert(state, assessment.key, { ...receipt, issue: { id: "confirmed" } }), true);
  assert.equal(state.alerts[assessment.key].issueId, "confirmed");
  assert.equal(alertDue(state, assessment, receipt.now, 24), false);
});
