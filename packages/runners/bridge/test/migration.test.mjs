import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { migratePaperclip } from "../migrate-paperclip.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";
import { withAdmission } from "../admission.mjs";

function source(t, count = 3) {
  const f = fixture(t), companyId = "company";
  const agents = [{ id: "perf-source", name: "SoftwareEngineerPerformance", companyId, status: "idle" },
    { id: "engineer-source", name: "SoftwareEngineer 2", companyId, status: "idle" }];
  const issues = Array.from({ length: count }, (_, i) => ({
    id: `issue-${i}`, identifier: `OFF-${i}`, companyId, title: `Original ${i}`, description: "Original brief",
    status: i === 1 ? "cancelled" : "done", assigneeAgentId: agents[i % 2].id,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
  }));
  const pr = { id: "123", branch: "user/fixture", url: "https://dev.azure.com/office/OC/_git/office-bohemia/pullrequest/123" };
  const config = { paperclipCompanyId: companyId, paperclipApiUrl: "http://fixture.invalid",
    creatorWorkspaces: { 123: f.workspace }, creatorProvenanceFile: path.join(f.root, "provenance.json") };
  writeJson(config.creatorProvenanceFile, { version: 1, records: [{
    companyId, prUrl: pr.url, branch: pr.branch, issueId: issues[0].id, creationRunId: "run-0", agentId: agents[0].id,
  }] });
  const requests = [];
  const get = async route => {
    requests.push(route);
    if (route === `/companies/${companyId}/agents`) return agents;
    if (route.startsWith(`/companies/${companyId}/issues?`)) {
      const offset = Number(new URL(`http://fixture.invalid${route}`).searchParams.get("offset"));
      return issues.slice(offset, offset + 200);
    }
    if (route === `/issues/${issues[0].id}`) return issues[0];
    if (route === `/agents/${agents[0].id}`) return agents[0];
    if (route === "/heartbeat-runs/run-0") return { id: "run-0", companyId, agentId: agents[0].id,
      sessionIdAfter: "real-provider-session", contextSnapshot: { issueId: issues[0].id, paperclipWorkspace: { cwd: f.workspace } } };
    if (route === `/issues/${issues[0].id}/runs`) return [{ runId: "run-0", agentId: agents[0].id }];
    if (/^\/issues\/issue-\d+\/comments$/.test(route)) return [{
      body: "Original comment", createdAt: "2026-09-02T00:00:00Z", authorAgentId: agents[0].id,
    }];
    throw new Error(`Unexpected fixture request: ${route}`);
  };
  return { ...f, requests, issues, agents, options: { store: f.store, config, get,
    ado: { listOwnPullRequests: async () => [pr] }, apply: true } };
}

test("migration imports every page, exact aliases, original comments and provider sessions without queuing backlog", async t => {
  const f = source(t, 349);
  const report = await migratePaperclip(f.options);
  assert.equal(report.tasks.length, 349);
  assert.equal(report.restoredMissing.length, 349);
  assert.ok(f.requests.some(route => route.endsWith("offset=200")));
  assert.ok(f.requests.some(route => route.endsWith("offset=349")));
  assert.equal(f.store.task("OFF-0").agent, "perf");
  assert.equal(f.store.task("OFF-1").agent, "software-engineer");
  assert.equal(f.store.task("OFF-0").workspace, f.workspace);
  assert.equal(f.store.task("OFF-0").session_id, "real-provider-session");
  assert.equal(f.store.task("OFF-0").comments[0].message, "Original comment");
  assert.ok(f.store.tasks().every(task => !["incoming", "in_progress"].includes(task.status)));
  assert.equal(report.tasks.find(task => task.taskId === "OFF-1").sourceStatus, "cancelled");
});

test("reimport preserves immutable backups, current Spool sessions, original brief, comments and rollout gate", async t => {
  const f = source(t);
  await migratePaperclip(f.options);
  const backupFile = path.join(f.store.records, "imports", "OFF-0.json");
  const backup = readJson(backupFile);
  const task = f.store.task("OFF-0");
  task.prompt = "A newer revision contract";
  task.session_id = "current-spool-session";
  task.comments.push({ author: "perf", message: "Spool result", created_at: "2026-09-15T00:00:00Z" });
  writeJson(task.file, task);
  writeJson(path.join(f.store.records, "task-OFF-0.json"), { creator: { taskId: task.id } });
  const registryFile = path.join(f.store.records, "ownership.json");
  writeJson(registryFile, { ...readJson(registryFile), verificationPrIds: ["123"] });
  const report = await migratePaperclip(f.options);
  assert.equal(report.restoredMissing.length, 0);
  assert.equal(f.store.task("OFF-0").comments.length, 2);
  assert.equal(f.store.task("OFF-0").session_id, "current-spool-session");
  assert.equal(report.pullRequests[0].originalPrompt, "Original brief");
  assert.deepEqual(report.verificationPrIds, ["123"]);
  assert.deepEqual(readJson(backupFile), backup);
});

test("unknown agent aliases and repeated source pages fail explicitly", async t => {
  const f = source(t);
  f.agents[0].name = "Unmapped identity";
  await assert.rejects(migratePaperclip(f.options), /explicit Spool identity mapping/);
  const get = f.options.get;
  await assert.rejects(migratePaperclip({ ...f.options,
    get: route => route.includes("/issues?") ? Promise.resolve(f.issues) : get(route),
  }), /pagination repeated/);
  assert.equal(f.store.tasks().length, 0);
});

test("migration cannot overwrite work while a runner is preparing its original agent", async t => {
  const f = source(t);
  await withAdmission(f.root, "perf", async () => {
    await assert.rejects(migratePaperclip(f.options), /idle runner preparation/);
    assert.equal(f.store.tasks().length, 0);
  });
});
