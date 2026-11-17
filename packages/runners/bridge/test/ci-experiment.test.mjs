import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fixture } from "./fixtures.mjs";
import { writeJson } from "../spool-store.mjs";
import { ciExperimentContract, beginCiExperiment, recordCiOutcome, readCiJob, runCiCommand } from "../ci-job.mjs";
import { ciExecutionContext, completeCiExecution } from "../ci-execution.mjs";
import { reconcileCiExperiment, queueCiValidation, publishAcceptedCiExperiment } from "../ci-experiment.mjs";
import { prReviewFingerprint, recordCheckedPublication } from "../../packages/bohemia-pr-mcp/src/pr-origin.mjs";
import { assertCiUpdate } from "../../packages/bohemia-pr-mcp/src/pr-update-guard.mjs";
import { eventRecipe } from "@spool/workflow";
import { runnerEngine } from "../native-supervisor.mjs";
import { readPublication } from "../../packages/bohemia-agent-tooling/src/publications.js";

function setup(t) {
  const f = fixture(t), taskId = "ci-job", head = "a".repeat(40), sessionId = randomUUID();
  writeFileSync(path.join(f.root, "agents", "ci.md"), "Fixture only.");
  const contract = ciExperimentContract(f.store);
  f.put({ id: taskId, agent: "ci", session_id: sessionId }, "in_progress");
  writeJson(path.join(f.store.records, `task-${taskId}.json`), { runner: "ci",
    preparation: { ...f.preparation, branch: "user/ci-test" },
    handoff: { discovery: true, ciExperiment: contract } });
  const owner = { version: 1, verified: true, agent: "ci", taskId, sessionId,
    workspace: f.workspace, branch: "user/ci-test", prId: "42", originId: "original-origin",
    targetBranch: "master", publications: [{ checked: true, head, draft: true }] };
  let pr = { id: "42", branch: owner.branch, sourceCommit: head, isDraft: true, status: "active",
    targetBranch: "master", description: "<!-- bohemia-origin:original-origin -->\nExperiment" };
  owner.publications[0].reviewHash = prReviewFingerprint(pr);
  writeJson(path.join(f.store.records, "native-creators", `${taskId}.json`), owner);
  const patches = [], requests = [], publications = [];
  const policies = [{ evaluationId: "policy", status: "notApplicable", configuration: {
    isEnabled: true, isBlocking: true, settings: { buildDefinitionId: 1 } }, context: {} }];
  const options = { store: f.store, taskId, config: { ado: {} },
    getPullRequest: async () => structuredClone(pr), listPolicies: async () => structuredClone(policies),
    requeue: async (_config, id) => { requests.push(id); policies[0].status = "running";
      policies[0].context = { buildId: 2, lastMergeSourceCommitId: head }; },
    abandon: async (_config, id) => { patches.push(id); pr.status = "abandoned"; },
    publish: async (_config, id) => { publications.push(id); pr.isDraft = false; },
    cleanWorkspace: () => true };
  const begin = () => beginCiExperiment(f.store, taskId, {
    candidate: "test/setup-cache", change: "Reuse setup without dropping tests", acceptance: 2 });
  const reject = () => recordCiOutcome(f.store, taskId, {
    verdict: "rejected", worked: "Coverage unchanged", failed: "No timing gain",
    next: "Choose a different critical-path cost", evidence: ["fixture-results.json"] });
  const fail = () => { const task = f.store.task(taskId); unlinkSync(task.file);
    f.put({ ...task, file: undefined }, "failed"); };
  return { ...f, taskId, head, contract, owner, options, patches, requests, publications, policies, begin, reject, fail,
    setPr: value => { pr = { ...pr, ...value }; } };
}
test("durable CI outcomes refresh concise history and prevent repeating a candidate", async t => {
  const f = setup(t); await f.begin(); await f.reject();
  assert.equal(readCiJob(f.store, f.taskId).outcome.verdict, "rejected");
  assert.match(readFileSync(f.contract.historyFile, "utf8"), /No timing gain/);
  await assert.rejects(f.begin(), /already settled/);
  const second = "ci-next"; f.put({ id: second, agent: "ci" }, "in_progress");
  writeJson(path.join(f.store.records, `task-${second}.json`), {
    ...f.store.metadata(f.taskId), preparation: f.preparation });
  await assert.rejects(beginCiExperiment(f.store, second, {
    candidate: "test/setup-cache", change: "Try the same cache again", acceptance: 2 }), /already attempted/);
});
test("a rejected failed original draft is abandoned before capacity is released", async t => {
  const f = setup(t); await f.begin(); await f.reject(); f.fail();
  assert.deepEqual(await reconcileCiExperiment(f.options), { released: true });
  assert.deepEqual(f.patches, ["42"]);
  assert.equal(readCiJob(f.store, f.taskId).closure.status, "abandoned");
  assert.deepEqual(await reconcileCiExperiment(f.options), { released: true });
  assert.equal(f.patches.length, 1);
});
for (const change of [{ isDraft: false }, { sourceCommit: "b".repeat(40) },
  { description: "Human-replaced description" }, { branch: "user/someone-else" },
  { description: "<!-- bohemia-origin:original-origin -->\nHuman edit" }, { targetBranch: "release" }]) {
  test(`cleanup refuses a taken-over draft: ${JSON.stringify(change)}`, async t => {
    const f = setup(t); await f.begin(); await f.reject(); f.fail(); f.setPr(change);
    await assert.rejects(reconcileCiExperiment(f.options), /original|checked|draft/);
    assert.equal(f.patches.length, 0);
  });
}
  test("cleanup rejects changed owner sessions and missing draft publication proof", async t => {
    const f = setup(t); await f.begin(); await f.reject(); f.fail();
    const file = path.join(f.store.records, "native-creators", `${f.taskId}.json`);
    for (const owner of [{ ...f.owner, sessionId: "other-session" },
      { ...f.owner, publications: [{ checked: true, head: f.head }] }]) {
      writeJson(file, owner);
      await assert.rejects(reconcileCiExperiment(f.options), /owner|publication/);
    }
    assert.equal(f.patches.length, 0);
  });
  test("lost abandonment acknowledgement reconciles the closed draft without another write", async t => {
    const f = setup(t); await f.begin(); await f.reject(); f.fail();
    await assert.rejects(reconcileCiExperiment({ ...f.options, abandon: async (...args) => {
      await f.options.abandon(...args); throw new Error("Lost acknowledgement");
    } }), /Lost acknowledgement/);
    assert.deepEqual(await reconcileCiExperiment(f.options), { released: true });
    assert.equal(f.patches.length, 1);
  });
  test("repeat validation cannot mistake the previous approved build for its new sample", async t => {
    const f = setup(t);
    f.policies[0].status = "approved";
    f.policies[0].context = { buildId: 1, lastMergeSourceCommitId: f.head };
    await queueCiValidation({ ...f.options, repeat: true, requeue: async () => {} });
    assert.equal((await queueCiValidation(f.options)).passed, false);
    await assert.rejects(queueCiValidation({ ...f.options, repeat: true }), /Await the new/);
  });
test("target advancement cannot reset the per-head validation budget", async t => {
  const f = setup(t); let buildId = 0;
  const options = { ...f.options, requeue: async () => {
    f.policies[0].status = "approved";
    f.policies[0].context = { buildId: ++buildId, lastMergeSourceCommitId: f.head };
  } };
  await queueCiValidation(options);
  await queueCiValidation({ ...options, repeat: true });
  await queueCiValidation({ ...options, repeat: true });
  f.setPr({ targetCommit: "c".repeat(40) });
  f.policies[0].context.isExpired = true;
  await assert.rejects(queueCiValidation(options), /three-sample budget/);
  assert.equal(buildId, 3);
});
test("blocked, cancelled, dirty and live original work do not churn into replacements", async t => {
  const f = setup(t); await f.begin();
  await recordCiOutcome(f.store, f.taskId, { verdict: "blocked", worked: "Local checks passed",
    failed: "Access unavailable", next: "Restore access on the original task", evidence: ["fixture.log"] });
  f.fail();
  assert.match((await reconcileCiExperiment(f.options)).holding, /blocked/);
  assert.equal(f.patches.length, 0);
});
test("a dirty rejected checkout and an active provider both hold safe settlement", async t => {
  const f = setup(t); await f.begin(); await f.reject(); f.fail();
  assert.match((await reconcileCiExperiment({ ...f.options, cleanWorkspace: () => false })).holding, /clean/);
  f.store.liveTasks = () => [f.store.task(f.taskId)];
  assert.match((await reconcileCiExperiment(f.options)).holding, /session/);
  assert.equal(f.patches.length, 0);
});
test("operator interruptions and failed dispositions never authorize draft cleanup", async t => {
  const f = setup(t); await f.begin(); await f.reject(); f.fail();
  const task = f.store.task(f.taskId);
  for (const change of [{ interaction: { cancel_requested: true } },
    { interaction: { paused: true } }, { error: "Marked failed by operator" }]) {
    f.put({ ...task, file: undefined, ...change }, "failed");
    assert.match((await reconcileCiExperiment(f.options)).holding, /operator/);
  }
  assert.equal(f.patches.length, 0);
});
test("blocked originals resume without erasing lessons and accepted review keeps its CI contract", async t => {
  const f = setup(t); await f.begin();
  await recordCiOutcome(f.store, f.taskId, { verdict: "blocked", worked: "Local checks passed",
    failed: "Access unavailable", next: "Restore access", evidence: ["blocked.log"] });
  await f.begin();
  assert.equal(readCiJob(f.store, f.taskId).priorOutcomes[0].outcome.verdict, "blocked");
  assert.match(readFileSync(f.contract.historyFile, "utf8"), /Access unavailable/);
  await recordCiOutcome(f.store, f.taskId, { verdict: "accepted", worked: "Required checks improved",
    failed: "No observed failure", next: "Human review", evidence: ["matched-results.json"],
    metrics: { before: [12, 12, 13], after: [8, 9, 8], runnerBefore: 40,
      runnerAfter: 35, coveragePreserved: true } }, {
    validate: async () => ({ passed: true, head: f.head }),
  });
  writeJson(path.join(f.store.records, `task-${f.taskId}.json`), {
    runner: "pr-updater", preparation: f.preparation, handoff: { prId: "42" },
  });
  assert.equal(readCiJob(f.store, f.taskId).outcome.verdict, "accepted");
  await assert.rejects(f.begin(), /settled/);
});
test("accepted outcomes refuse pending checks, insufficient gain and increased runner cost", async t => {
  const f = setup(t); await f.begin();
  const input = { verdict: "accepted", worked: "Local timing changed", failed: "Not established",
    next: "Continue measurement", evidence: ["results.json"],
    metrics: { before: [12, 12, 12], after: [11, 11, 11], runnerBefore: 40,
      runnerAfter: 40, coveragePreserved: true } };
  await assert.rejects(recordCiOutcome(f.store, f.taskId, input, {
    validate: async () => ({ passed: false, head: f.head }),
  }), /not passed/);
  await assert.rejects(recordCiOutcome(f.store, f.taskId, input, {
    validate: async () => ({ passed: true, head: f.head }),
  }), /preset measured gain/);
  await assert.rejects(recordCiOutcome(f.store, f.taskId, { ...input,
    metrics: { ...input.metrics, after: [8, 8, 8], runnerAfter: 50 } }, {
    validate: async () => ({ passed: true, head: f.head }),
  }), /runner cost/);
});
test("draft validation queues required builds once per checked head without cancelling running checks", async t => {
  const f = setup(t);
  await queueCiValidation(f.options);
  await queueCiValidation(f.options);
  assert.deepEqual(f.requests, ["policy"]);
  f.policies[0].status = "approved";
  assert.equal((await queueCiValidation(f.options)).passed, true);
});
test("finish verifies an unchanged ready PR without queueing or changing its validation ledger", async t => {
  const f = setup(t);
  f.setPr({ isDraft: false });
  f.policies[0].status = "approved";
  f.policies[0].configuration.settings.queueOnSourceUpdateOnly = true;
  f.policies[0].context = { buildId: 2, lastMergeSourceCommitId: f.head, buildIsNotCurrent: true };
  assert.equal((await queueCiValidation({ ...f.options, readOnly: true })).passed, true);
  f.owner.publications[0].draft = false;
  writeJson(path.join(f.store.records, "native-creators", `${f.taskId}.json`), f.owner);
  assert.equal((await queueCiValidation({ ...f.options, readOnly: true })).passed, true);
  assert.equal(f.requests.length, 0);
  assert.equal(existsSync(path.join(f.store.records, "ci-validations", `${f.taskId}.json`)), false);
  await assert.rejects(queueCiValidation(f.options), /publication|original draft/);
  await assert.rejects(queueCiValidation({ ...f.options, readOnly: true, repeat: true }), /Read-only/);
});
for (const change of [
  { status: "running" }, { status: "rejected" },
  { context: { buildId: 2, lastMergeSourceCommitId: "b".repeat(40) } },
  { context: { buildId: 2, lastMergeSourceCommitId: "a".repeat(40), isExpired: true } },
  { context: { buildId: 2, lastMergeSourceCommitId: "a".repeat(40), buildIsNotCurrent: true } },
  { context: { lastMergeSourceCommitId: "a".repeat(40) } },
  { evaluationId: undefined },
]) {
  test(`read-only ready-PR verification refuses unproven checks: ${JSON.stringify(change)}`, async t => {
    const f = setup(t);
    f.setPr({ isDraft: false });
    Object.assign(f.policies[0], { status: "approved",
      context: { buildId: 2, lastMergeSourceCommitId: f.head } }, change);
    assert.equal((await queueCiValidation({ ...f.options, readOnly: true })).passed, false);
    assert.equal(f.requests.length, 0);
  });
}
test("read-only ready verification still rejects human edits and publications changed during verification", async t => {
  const f = setup(t);
  f.setPr({ isDraft: false, description: "Human edit" });
  await assert.rejects(queueCiValidation({ ...f.options, readOnly: true }), /changed/);
  f.setPr({ description: "<!-- bohemia-origin:original-origin -->\nExperiment" });
  await assert.rejects(queueCiValidation({ ...f.options, readOnly: true,
    listPolicies: async (...args) => {
      f.setPr({ status: "abandoned" });
      return f.options.listPolicies(...args);
    },
  }), /changed during/);
});
test("local-first acceptance retains explicit local worker duration without inventing hosted metrics", async t => {
  const f = setup(t); await f.begin();
  const metrics = { before: [12, 12, 13], after: [8, 9, 8], runnerBefore: 37, runnerAfter: 25,
    runnerScope: "local-single-worker-wall-seconds", coveragePreserved: true,
    hostedPerformanceMeasured: false, hostedCostMeasured: false };
  const job = await recordCiOutcome(f.store, f.taskId, { verdict: "accepted",
    worked: "Matched local command improved and required CI passed", failed: "No observed correctness failure",
    next: "Human review; hosted savings remain unmeasured", evidence: ["raw-local-worker-samples.json"],
    metrics }, { validate: async () => ({ passed: true, head: f.head }) });
  assert.deepEqual(job.outcome.metrics, metrics);
});
test("publication records the checked gate target instead of a newer unavailable remote target", async t => {
  const f = setup(t);
  const git = (...args) => execFileSync("git", args, { cwd: f.workspace, encoding: "utf8",
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "--allow-empty", "-m", "Fixture base");
  const head = git("rev-parse", "HEAD"), gateFile = path.join(f.workspace, ".git", "bohemia-gate-pass.json");
  const prUrl = "https://example.test/pullrequest/42";
  const owner = { ...f.owner, prUrl, publications: [] };
  writeJson(path.join(f.store.records, "native-creators", `${f.taskId}.json`), owner);
  const gate = { head, targetCommit: head, targetBranch: "origin/master", passedAt: new Date().toISOString() };
  writeJson(gateFile, gate);
  const options = { context: { agent: "ci", taskId: f.taskId, sessionId: owner.sessionId,
    workspace: f.workspace, projectRoot: f.root, receiptDirectory: f.store.publicationDirectory },
    repoRoot: f.workspace, prUrl, headCommit: head, targetCommit: "f".repeat(40),
    pr: { pullRequestId: 42, sourceRefName: `refs/heads/${owner.branch}`, targetRefName: "refs/heads/master",
      status: "active", isDraft: false, lastMergeSourceCommit: { commitId: head } } };
  await recordCheckedPublication(options);
  const publication = readPublication(prUrl, f.store.publicationDirectory).publications[0];
  assert.equal(publication.targetCommit, head);
  assert.equal(publication.baseCommit, head);
  assert.equal(publication.draft, false);
  for (const change of [{ head: "b".repeat(40) }, { targetBranch: "origin/release" }, { passedAt: "invalid" }]) {
    writeJson(gateFile, { ...gate, ...change });
    await assert.rejects(recordCheckedPublication(options), /successful gate target/);
  }
  unlinkSync(gateFile);
  await assert.rejects(recordCheckedPublication(options), /successful gate target/);
});
test("unaccepted user-promoted CI allows checked metadata updates but never publishes a new source", () => {
  const head = "a".repeat(40), pr = { isDraft: false, targetRefName: "refs/heads/master",
    lastMergeSourceCommit: { commitId: head } };
  const publication = { checked: true, head };
  assert.doesNotThrow(() => assertCiUpdate(pr, { accepted: false, publication }));
  assert.throws(() => assertCiUpdate(pr, { accepted: false }), /original checked source/);
  assert.throws(() => assertCiUpdate(pr, { accepted: false, publication: { checked: false, head } }), /checked source/);
  assert.throws(() => assertCiUpdate(pr, { accepted: false, publication,
    headCommit: "b".repeat(40) }), /checked source/);
  assert.throws(() => assertCiUpdate(pr, { accepted: false, publication,
    targetRefName: "refs/heads/release" }), /checked source/);
  assert.throws(() => assertCiUpdate({ ...pr, lastMergeSourceCommit: { commitId: "b".repeat(40) } },
    { accepted: false, publication }), /checked source/);
  assert.doesNotThrow(() => assertCiUpdate(pr, { accepted: true, headCommit: "b".repeat(40) }));
  assert.doesNotThrow(() => assertCiUpdate({ ...pr, isDraft: true }, { accepted: false }));
});
async function acceptForPublication(f) {
  await f.begin();
  f.policies[0].status = "approved";
  f.policies[0].context = { buildId: 2, lastMergeSourceCommitId: f.head };
  return recordCiOutcome(f.store, f.taskId, { verdict: "accepted",
    worked: "Matched local proof and required CI passed", failed: "No observed failure",
    next: "Ready for review", evidence: ["local-results.json", "current-source-ci.json"],
    metrics: { before: [12, 12, 13], after: [8, 9, 8], runnerBefore: 37, runnerAfter: 25,
      runnerScope: "local-single-worker-wall-seconds", coveragePreserved: true } },
  { validate: async () => ({ passed: true, head: f.head }) });
}
test("accepted original work publishes once before verified native completion and releases CI settlement", async t => {
  const f = setup(t), options = execution(f);
  f.owner.sessionId = f.store.task(f.taskId).session_id;
  writeJson(path.join(f.store.records, "native-creators", `${f.taskId}.json`), f.owner);
  const job = await acceptForPublication(f);
  assert.deepEqual(await publishAcceptedCiExperiment(f.options), {
    prId: "42", head: f.head, readyForReview: true,
  });
  assert.deepEqual(f.publications, ["42"]);
  await publishAcceptedCiExperiment(f.options);
  assert.equal(f.publications.length, 1);
  completeCiExecution(f.store, f.taskId, job, options);
  assert.equal(f.store.task(f.taskId).status, "completed");
  assert.deepEqual(await reconcileCiExperiment(f.options), { released: true });
  assert.equal(f.patches.length, 0);
});
test("lost publication acknowledgement keeps evidence and recovers without republishing", async t => {
  const f = setup(t); await acceptForPublication(f);
  await assert.rejects(publishAcceptedCiExperiment({ ...f.options, publish: async (...args) => {
    await f.options.publish(...args); throw new Error("Lost readiness acknowledgement");
  } }), /Lost readiness/);
  assert.equal(f.store.task(f.taskId).status, "in_progress");
  assert.equal(readCiJob(f.store, f.taskId).outcome.verdict, "accepted");
  await publishAcceptedCiExperiment(f.options);
  assert.equal(f.publications.length, 1);
});
for (const verdict of ["blocked", "rejected"]) {
  test(`${verdict} evidence never publishes even when CI is approved`, async t => {
    const f = setup(t); await f.begin();
    await recordCiOutcome(f.store, f.taskId, { verdict, worked: "CI passed",
      failed: "Performance unproven", next: "Keep original evidence", evidence: ["result.json"] });
    f.policies[0].status = "approved";
    f.policies[0].context = { buildId: 2, lastMergeSourceCommitId: f.head };
    await assert.rejects(publishAcceptedCiExperiment(f.options), /accepted original/);
    assert.equal(f.publications.length, 0);
  });
}
test("accepted publication still refuses stale CI, interruption and an unverified readiness write", async t => {
  const f = setup(t); await acceptForPublication(f);
  f.policies[0].status = "running";
  await assert.rejects(publishAcceptedCiExperiment(f.options), /passing current-source/);
  f.policies[0].status = "approved";
  const task = f.store.task(f.taskId);
  f.put({ ...task, file: undefined, interaction: { cancel_requested: true } }, "in_progress");
  await assert.rejects(publishAcceptedCiExperiment(f.options), /interrupted/);
  f.put({ ...task, file: undefined }, "in_progress");
  await assert.rejects(publishAcceptedCiExperiment({ ...f.options, publish: async () => {} }), /not verified/);
  assert.equal(f.publications.length, 0);
  assert.equal(f.store.task(f.taskId).status, "in_progress");
});
test("a lost queue response is recovered from current-head policy evidence without requeue", async t => {
  const f = setup(t);
  const requeue = async (...args) => { await f.options.requeue(...args); throw new Error("Lost response"); };
  await assert.rejects(queueCiValidation({ ...f.options, requeue }), /Lost response/);
  assert.equal((await queueCiValidation(f.options)).passed, false);
  assert.equal(f.requests.length, 1);
});
test("unknown queue outcomes, foreign heads and absent policies never become success", async t => {
  const f = setup(t);
  await assert.rejects(queueCiValidation({ ...f.options, requeue: async () => { throw new Error("Denied"); } }), /Denied/);
  await assert.rejects(queueCiValidation(f.options), /uncertain/);
  assert.equal(f.requests.length, 0);
  f.setPr({ sourceCommit: "b".repeat(40) });
  await assert.rejects(queueCiValidation(f.options), /checked/);
  f.setPr({ sourceCommit: f.head });
  await assert.rejects(queueCiValidation({ ...f.options, listPolicies: async () => [] }), /policies/);
});
test("actual CI helper CLI validates without an unsettled circular top-level await", t => {
  const f = setup(t), sessionId = randomUUID(), contextFile = path.join(f.root, "controls", "executions", `${f.taskId}.json`);
  f.put({ ...f.store.task(f.taskId), file: undefined, session_id: sessionId }, "in_progress");
  unlinkSync(path.join(f.store.records, "native-creators", `${f.taskId}.json`));
  writeJson(contextFile, { version: 1, originKind: "spool", agent: "ci", taskId: f.taskId,
    sessionId, workspace: f.workspace, branch: "user/ci-test",
    receiptDirectory: path.join(f.store.records, "native-creators") });
  writeJson(path.join(f.root, ".runner", "automation", "spool-runners.json"), {
    spool_dir: f.root, custom_runners: { ci: { id: "ci", name: "CI", kind: "custom", enabled: true,
      workspace: f.workspace, intervalSeconds: 60, ...eventRecipe("ci", { agent: "ci" }) } },
  });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../ci-job.mjs", import.meta.url)),
    "validate", "--spool-root", f.root, "--task-id", f.taskId], {
    cwd: f.workspace, encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, SPOOL_EXECUTION_CONTEXT: contextFile, COPILOT_SESSION_ID: sessionId,
      REPOSITORY_MCP_PUBLICATIONS: f.store.publicationDirectory },
  });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), { passed: false, holding: "CI candidate draft has not been published" });
});

test("CI context resolves its original execution without exposing task plumbing", t => {
  const f = setup(t), sessionId = randomUUID(), contextFile = path.join(f.root, "controls", "executions", `${f.taskId}.json`);
  f.put({ ...f.store.task(f.taskId), file: undefined, session_id: sessionId }, "in_progress");
  writeJson(contextFile, { version: 1, originKind: "spool", agent: "ci", taskId: f.taskId,
    sessionId, workspace: f.workspace, branch: "user/ci-test",
    receiptDirectory: path.join(f.store.records, "native-creators") });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../ci-job.mjs", import.meta.url)), "context"], {
    cwd: f.workspace, encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, SPOOL_EXECUTION_CONTEXT: contextFile, COPILOT_SESSION_ID: sessionId,
      REPOSITORY_MCP_PUBLICATIONS: f.store.publicationDirectory },
  });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stderr}`);
  const context = JSON.parse(result.stdout);
  assert.equal(context.workspace, f.workspace);
  assert.equal(context.branch, "user/ci-test");
  assert.match(context.history, /CI outcomes/);
  assert.doesNotMatch(result.stdout, /--spool-root|runner-receipts|taskId|providerToken|sessionId|receiptDirectory/i);
});

function execution(f) {
  const sessionId = randomUUID(), contextFile = path.join(f.root, "controls", "executions", `${f.taskId}.json`);
  f.put({ ...f.store.task(f.taskId), file: undefined, session_id: sessionId }, "in_progress");
  writeJson(contextFile, { version: 1, originKind: "spool", agent: "ci", taskId: f.taskId,
    sessionId, workspace: f.workspace, branch: "user/ci-test",
    receiptDirectory: path.join(f.store.records, "native-creators") });
  return { environment: { ...process.env, SPOOL_EXECUTION_CONTEXT: contextFile, COPILOT_SESSION_ID: sessionId,
    REPOSITORY_MCP_PUBLICATIONS: f.store.publicationDirectory },
    binary: process.env.SPOOL_TEST_BINARY || runnerEngine() };
}

test("CI finish owns native result and status delivery without agent task commands", async t => {
  const f = setup(t), options = execution(f), file = path.join(f.root, "outcome.json");
  await f.begin();
  const input = { verdict: "rejected", worked: "Coverage preserved", failed: "No local gain",
    next: "Choose another cost", evidence: ["local-results.json"] };
  writeJson(file, input);
  const before = f.store.task(f.taskId);
  const result = await runCiCommand(["finish", "--json", file], options);
  assert.equal(result.outcome.verdict, "rejected");
  assert.doesNotMatch(JSON.stringify(result), /taskId|origin|runner-receipts|sessionId/);
  const task = f.store.task(f.taskId);
  assert.equal(task.status, "failed"); assert.equal(task.error, input.failed);
  assert.equal(task.session_id, before.session_id); assert.equal(task.workspace, before.workspace);
  assert.equal(task.agent, before.agent); assert.equal(task.prompt, before.prompt);
  assert.deepEqual(task.comments, before.comments);
  await runCiCommand(["finish", "--json", file], options);
  assert.equal(f.store.task(f.taskId).comments.length, task.comments.length);
  writeJson(file, { ...input, failed: "Different result" });
  await assert.rejects(runCiCommand(["finish", "--json", file], options), /immutable/);
});

test("CI completion failures preserve durable evidence and do not claim completion", async t => {
  const f = setup(t); await f.begin(); await f.reject();
  const job = readCiJob(f.store, f.taskId);
  assert.throws(() => completeCiExecution(f.store, f.taskId, job, { binary: "unused",
    execute: () => ({ status: 1, stderr: "Runtime unavailable" }) }), /completion was not confirmed/);
  assert.equal(f.store.task(f.taskId).status, "in_progress");
  assert.deepEqual(readCiJob(f.store, f.taskId), job);
  const task = f.store.task(f.taskId);
  f.put({ ...task, file: undefined, interaction: { cancel_requested: true } }, "in_progress");
  assert.throws(() => completeCiExecution(f.store, f.taskId, job, {
    execute: () => assert.fail("Cancelled work must not publish a result"),
  }), /interrupted/);
});

test("CI commands refuse replacement roots, tasks and restored sessions", t => {
  const f = setup(t), options = execution(f);
  assert.equal(ciExecutionContext(options).taskId, f.taskId);
  assert.throws(() => ciExecutionContext({ ...options, root: f.workspace }), /replace/);
  assert.throws(() => ciExecutionContext({ ...options, taskId: "other" }), /replace/);
  f.put({ ...f.store.task(f.taskId), file: undefined, session_id: randomUUID() }, "in_progress");
  assert.throws(() => ciExecutionContext(options), /original active execution/);
});

test("CI finish records a blocked experiment without requiring candidate selection first", async t => {
  const f = setup(t), options = execution(f), file = path.join(f.root, "blocked.json");
  writeJson(file, { verdict: "blocked", candidate: "test/local-runtime", change: "Reproduce the CI runtime locally",
    worked: "Existing evidence preserved", failed: "Required local runtime unavailable",
    next: "Restore the local runtime", evidence: ["local-blocker.log"] });
  const result = await runCiCommand(["finish", "--json", file], options);
  assert.equal(result.outcome.verdict, "blocked");
  assert.equal(f.store.task(f.taskId).status, "failed");
  assert.equal(f.store.task(f.taskId).error, "Required local runtime unavailable");
  assert.equal((await reconcileCiExperiment(f.options)).holding, "Original CI task is blocked or cancelled; continue it rather than churning replacements");
});

test("CI native completion accepts only the recorded verdict and recovers a lost acknowledgement", async t => {
  const f = setup(t), options = execution(f); await f.begin();
  const job = await recordCiOutcome(f.store, f.taskId, { verdict: "accepted",
    worked: "Matched hosted checks improved", failed: "No observed failure", next: "Human review",
    evidence: ["hosted-results.json"], metrics: { before: [12, 12, 13], after: [8, 8, 9],
      runnerBefore: 40, runnerAfter: 35, coveragePreserved: true } }, {
    validate: async () => ({ passed: true, head: f.head }),
  });
  assert.throws(() => completeCiExecution(f.store, f.taskId, {
    ...job, outcome: { ...job.outcome, next: "Unrecorded replacement" },
  }, { execute: () => assert.fail("Unrecorded outcomes must not reach the status API") }), /recorded immutable/);
  completeCiExecution(f.store, f.taskId, job, { ...options, execute: (...args) => {
    const result = spawnSync(...args);
    assert.equal(result.status, 0, result.stderr);
    return { status: 1, stdout: "", stderr: "Lost acknowledgement" };
  } });
  assert.equal(f.store.task(f.taskId).status, "completed");
  assert.deepEqual(readCiJob(f.store, f.taskId).outcome, job.outcome);
  completeCiExecution(f.store, f.taskId, job, { execute: () => assert.fail("Do not repeat a verified result") });
});
