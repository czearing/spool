import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inspectUnchangedInvestigation, recoverNativeInvestigation } from "../native-investigation-recovery.mjs";
import { fixture as spoolFixture } from "./fixtures.mjs";
import { nativeControls } from "./native-controls-fixture.mjs";
import { createMonitorControls } from "../monitor-controls.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-investigation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "agents"));
  const role = path.join(root, "agents", "perf.md");
  fs.writeFileSync(role, "Original production scope; keep all acceptance gates.");
  const provider = { command: "node", workingDirectory: "/workspaces/1JS",
    args: [path.join(root, "codespaces", "copilot.mjs"), "--config", path.join(root, "profile.json")] };
  fs.writeFileSync(path.join(root, "spool.json"), JSON.stringify({ copilotProviders: { perf: provider } }));
  const metadata = { runner: "library-perf", source: "perf", handoff: { discovery: true, maxOpenPrs: 3 } };
  const task = { id: "original", agent: "perf", workspace: root, status: "failed", error: "No valid baseline",
    session_id: "original-session", updated_at: "2026-10-24T22:00:00Z", session_config: { provider } };
  const calls = [], accepted = new Map();
  let clock = Date.parse(task.updated_at) + 60001;
  const store = { root, records: path.join(root, "records"), metadata: () => metadata,
    task: () => task, workspaceIdentity: () => root, isPaused: () => false,
    submission: () => null, assertIdle() {} };
  const preparation = { ready: true, repoRoot: root, branch: "user/owner/original", commit: "a".repeat(40) };
  const baseline = { branch: preparation.branch, commit: preparation.commit, configSha256: "original-config", preparation };
  const options = { store, task, workspace: root, config: { repositoryProfile: "1js", agentId: "perf" },
    readProfile: () => ({ purpose: "engineering", remoteRoot: "/workspaces/1JS", workspace: root }),
    inspect: async () => baseline, capacity: async () => ({ holding: null }), now: () => clock,
    controls: { receipt: id => accepted.get(id),
      submit: request => { calls.push(request); accepted.set(request.id, { status: "queued" }); } } };
  const revise = () => fs.writeFileSync(role, "Clarified production scope; preserve measurements, checks and publication gates.");
  return { options, store, task, calls, revise, baseline, advance: ms => { clock += ms; } };
}

test("missing or blocked preparation cannot be mistaken for an unchanged verified investigation", async t => {
  const f = fixture(t), profile = { workspace: f.store.root };
  assert.equal(await inspectUnchangedInvestigation(profile, {}), null);
  fs.writeFileSync(path.join(profile.workspace, "preparation.json"),
    JSON.stringify({ ready: false, status: "blocked", error: "Approved-feed dependency unavailable" }));
  assert.equal(await inspectUnchangedInvestigation(profile, {}), null);
  assert.deepEqual(f.calls, []);
});

for (const dirty of [false, true]) {
  test(`authored ${dirty ? "uncommitted" : "committed"} work is held without treating legitimate progress as corruption`, async t => {
    const f = fixture(t), configFile = path.join(f.store.root, "profile.json");
    const profile = { workspace: f.store.root, file: configFile, purpose: "engineering",
      codespace: "owned-perf", remoteRoot: "/workspaces/1JS",
      nativeProfile: { nodeExecutable: "/usr/bin/node", baseBranch: "main" } };
    fs.writeFileSync(configFile, "{}");
    const prepared = { ...f.baseline.preparation,
      configSha256: createHash("sha256").update("{}").digest("hex"),
      execution: { kind: "codespace", purpose: "engineering", codespace: profile.codespace,
        nativeRepoRoot: profile.remoteRoot },
      nativePreparation: { ready: true, commit: f.baseline.commit,
        branch: f.baseline.branch, repoRoot: profile.remoteRoot } };
    const receipt = path.join(f.store.root, "preparation.json");
    fs.writeFileSync(receipt, JSON.stringify(prepared));
    const before = fs.readFileSync(receipt, "utf8"), calls = [];
    const snapshot = { root: profile.remoteRoot, branch: prepared.branch,
      commit: dirty ? prepared.commit : "b".repeat(40),
      worktreeStatus: dirty ? "sha256:authored-work" : "" };
    const transport = { environment: async () => {},
      ssh: async command => {
        calls.push(command);
        return { stdout: command.includes("rev-list") ? "1\n" : JSON.stringify(snapshot) };
      },
      dispose: async () => calls.push("disposed") };
    assert.equal(await inspectUnchangedInvestigation(profile, {}, { transport }), null);
    assert.equal(fs.readFileSync(receipt, "utf8"), before);
    assert.equal(calls.at(-1), "disposed");
    snapshot.branch = "another-agents-branch";
    await assert.rejects(inspectUnchangedInvestigation(profile, {}, { transport }),
      /branch or working revision changed/);
  });
}

test("any failed native investigation resumes the original task without changing role instructions", async t => {
  const f = fixture(t);
  const role = path.join(f.store.root, "agents", "perf.md"), original = fs.readFileSync(role, "utf8");
  assert.match((await recoverNativeInvestigation(f.options)).holding, /Resuming original failed task/);
  const request = f.calls[0];
  assert.equal(request.taskId, f.task.id);
  assert.equal(request.kind, "status");
  assert.equal(request.metadata, undefined);
  assert.equal(f.store.metadata().handoff.discovery, true);
  assert.equal(request.message, undefined);
  assert.equal(request.expectedStatus, "failed");
  assert.equal(request.status, "in_progress");
  assert.equal(fs.readFileSync(role, "utf8"), original);
  assert.equal(f.task.status, "failed");
  assert.equal(f.task.error, "No valid baseline");
  assert.match((await recoverNativeInvestigation(f.options)).holding, /already accepted/);
  assert.equal(f.calls.length, 1);
});

test("pauses, live providers, contracts, cancellations and non-1JS tasks never auto-retry", async t => {
  for (const block of [
    f => { f.task.provider = { pid: 123 }; },
    f => { f.task.acceptance = { required: true }; },
    f => { f.task.interaction = { paused: true }; },
    f => { f.store.isPaused = () => true; },
    f => { f.options.config.repositoryProfile = "bohemia"; },
    f => { f.task.status = "cancelled"; },
    f => { f.task.status = "completed"; },
    f => { f.task.status = "in_progress"; },
  ]) {
    const f = fixture(t);
    block(f);
    assert.equal(await recoverNativeInvestigation(f.options), null);
    assert.deepEqual(f.calls, []);
  }
});

test("shared account cooldown defers original investigation before capacity checks or task admission", async t => {
  const f = fixture(t);
  const original = f.options.readProfile;
  f.options.readProfile = () => ({ ...original(), githubAccount: "shared", codespace: "original" });
  f.options.requests = { check: () => { throw Object.assign(new Error("Waiting for GitHub API reset"),
    { code: "GITHUB_RATE_LIMITED", retryAt: "2026-11-02T20:00:00Z" }); } };
  f.options.capacity = () => assert.fail("Cooldown must not trigger more work");
  assert.equal((await recoverNativeInvestigation(f.options)).retryAt, "2026-11-02T20:00:00Z");
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(path.join(f.store.records, "native-investigations")), false);
});

test("a recovered GitHub quota does not impose a second generic investigation backoff", async t => {
  const f = fixture(t);
  f.advance(-59001);
  f.task.error = "GitHub API rate limit blocked publication";
  assert.match((await recoverNativeInvestigation(f.options)).holding, /Resuming original failed task/);
  assert.equal(f.calls[0].kind, "status");
});

test("live workspace owners and full PR capacity defer recovery without remote preparation or inspection", async t => {
  for (const reason of ["Another task owns this agent/workspace", "Open PR limit reached (3/3)"]) {
    const f = fixture(t);
    f.options.capacity = async () => ({ holding: reason });
    f.store.assertIdle = () => assert.fail("Occupied work must not be admitted");
    f.options.inspect = async () => assert.fail("Recovery must not inspect or reset another checkout");
    assert.equal((await recoverNativeInvestigation(f.options)).holding, reason);
    assert.deepEqual(f.calls, []);
  }
});

test("retry cooldown increases across failures, survives a new scan instance, and preserves failure history", async t => {
  const f = fixture(t);
  f.advance(-59001);
  const first = await recoverNativeInvestigation(f.options);
  assert.match(first.holding, /backoff/);
  assert.equal(Date.parse(first.retryAt), Date.parse(f.task.updated_at) + 60000);
  assert.deepEqual(f.calls, []);
  f.advance(60000);
  await recoverNativeInvestigation({ ...f.options });
  assert.equal(f.calls.length, 1);
  f.task.updated_at = new Date(f.options.now()).toISOString();
  f.task.error = "A different environment failure";
  const second = await recoverNativeInvestigation(f.options);
  assert.equal(second.recoveryAttempt, 2);
  assert.equal(Date.parse(second.retryAt), Date.parse(f.task.updated_at) + 120000);
  f.advance(120000);
  await recoverNativeInvestigation(f.options);
  assert.equal(f.calls.length, 2);
  const journal = JSON.parse(fs.readFileSync(path.join(f.store.records, "native-investigations", "original.json")));
  assert.deepEqual(journal.failures.map(failure => failure.error), ["No valid baseline", "A different environment failure"]);
  for (let attempt = 3; attempt <= 8; attempt++) {
    f.task.updated_at = new Date(f.options.now() + 1).toISOString();
    const waiting = await recoverNativeInvestigation(f.options);
    assert.equal(waiting.recoveryAttempt, attempt);
    assert.ok(Date.parse(waiting.retryAt) - Date.parse(f.task.updated_at) <= 1800000);
    f.advance(1800001);
    await recoverNativeInvestigation(f.options);
  }
});

test("provider ownership and task generation changes cannot replay stale work", async t => {
  const owner = fixture(t);
  owner.task.session_config.provider = { command: "another" };
  await assert.rejects(recoverNativeInvestigation(owner.options), /ownership changed/);
  const changed = fixture(t);
  changed.store.task = () => ({ ...changed.task, updated_at: "2026-10-24T22:10:00Z" });
  assert.match((await recoverNativeInvestigation(changed.options)).holding, /task changed/);
  assert.deepEqual(changed.calls, []);
});

test("authored or published work stays in the same task and session instead of requiring a clean baseline", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.store.records, "native-creators"), { recursive: true });
  fs.writeFileSync(path.join(f.store.records, "native-creators", "original.json"), '{"verified":true,"prId":123}');
  f.options.inspect = async () => assert.fail("Must not require an unchanged or clean checkout");
  await recoverNativeInvestigation(f.options);
  assert.equal(f.calls[0].taskId, "original");
  assert.equal(f.task.session_id, "original-session");
});

test("queued input resumes without duplicating it; uncertain input is never automatically replayed", async t => {
  const f = fixture(t), submitted = [];
  f.task.interaction = { messages: [{ status: "queued", content: "Existing feedback" }] };
  let receipt;
  f.options.controls = { receipt: () => receipt, submit: command => { submitted.push(command); receipt = { status: "queued" }; } };
  await recoverNativeInvestigation(f.options);
  await recoverNativeInvestigation(f.options);
  assert.equal(submitted.length, 1);
  assert.deepEqual({ ...submitted[0], id: undefined }, { id: undefined, kind: "status",
    taskId: "original", status: "in_progress", expectedStatus: "failed" });
  assert.deepEqual(f.calls, []);
  f.task.interaction.messages[0].status = "sending";
  assert.match((await recoverNativeInvestigation(f.options)).holding, /uncertain/);
  assert.equal(submitted.length, 1);
});

test("pending recovery is a normal hold even while its own admission reserves the workspace", async t => {
  const f = fixture(t);
  await recoverNativeInvestigation(f.options);
  f.store.assertIdle = () => assert.fail("Pending recovery already owns admission");
  assert.match((await recoverNativeInvestigation(f.options)).holding, /accepted or pending/);
  assert.equal(f.calls.length, 1);
});

test("a rejected native admission backs off and retries instead of permanently disabling the runner", async t => {
  const f = fixture(t);
  f.task.error = "GitHub API rate limit blocked publication";
  await recoverNativeInvestigation(f.options);
  const first = f.calls[0];
  const receipt = f.options.controls.receipt;
  f.options.controls.receipt = id => id === first.id
    ? { result: { status: "failed", error: "Transient native admission failure" } } : receipt(id);
  const deferred = await recoverNativeInvestigation(f.options);
  assert.match(deferred.holding, /admission failed/);
  assert.equal(deferred.recoveryAttempt, 2);
  assert.equal(f.calls.length, 1);
  assert.match((await recoverNativeInvestigation(f.options)).holding, /backoff/);
  f.advance(120000);
  await recoverNativeInvestigation(f.options);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[1].id, first.id);
  assert.equal(f.calls[1].taskId, first.taskId);
});

test("startup failures without a session can recover without losing original assignment", async t => {
  const f = fixture(t);
  f.task.session_id = null;
  f.task.session_config = null;
  await recoverNativeInvestigation(f.options);
  assert.equal(f.calls[0].taskId, f.task.id);
  assert.equal(f.calls[0].kind, "status");
});

test("native backlog recovery retains the original work-item contract without requiring a role revision", async t => {
  const f = fixture(t), agent = "software-engineer-2";
  f.task.agent = agent;
  f.options.config.agentId = agent;
  f.store.metadata().source = "backlog";
  f.store.metadata().runner = "library-backlog";
  f.store.metadata().handoff = { workItem: { id: 2, parent: 1, project: "OC" } };
  fs.writeFileSync(path.join(f.store.root, "spool.json"), JSON.stringify({
    copilotProviders: { [agent]: f.task.session_config.provider },
  }));
  await recoverNativeInvestigation(f.options);
  assert.equal(f.task.agent, agent);
  assert.equal(f.store.metadata().handoff.workItem.id, 2);
  assert.equal(f.calls[0].taskId, f.task.id);
});

test("a project-root alias retains original task ownership while admitting its registered native workspace", async t => {
  const f = fixture(t), assigned = path.join(f.store.root, "assigned");
  fs.mkdirSync(assigned);
  f.store.workspaceIdentity = () => assigned;
  f.options.readProfile = () => ({ purpose: "engineering", remoteRoot: "/workspaces/1JS", workspace: assigned });
  f.baseline.preparation.repoRoot = assigned;
  await recoverNativeInvestigation(f.options);
  assert.equal(f.calls[0].taskId, f.task.id);
  assert.equal(f.calls[0].metadata, undefined);
  assert.equal(f.task.workspace, f.store.root);
});

test("the native engine admits an unprepared failed discovery without a fabricated branch or duplicate task", async t => {
  const f = spoolFixture(t), profileFile = path.join(f.root, "profile.json");
  fs.writeFileSync(profileFile, JSON.stringify({ workspace: f.workspace, purpose: "engineering" }));
  const provider = { command: process.execPath, workingDirectory: "/workspaces/1JS",
    args: [path.join(f.root, "codespaces", "copilot.mjs"), "--config", profileFile] };
  fs.writeFileSync(path.join(f.root, "spool.json"), JSON.stringify({
    version: 1, defaultModel: "fixture-model", copilotProviders: { perf: provider },
  }));
  const metadata = { runner: "library-perf", source: "perf", key: "original-discovery", handoff: { discovery: true } };
  f.put({ id: "original", agent: "perf", error: "Node version mismatch", session_id: randomUUID(),
    session_config: { model: "fixture-model", agent: "perf", workspace: f.workspace, provider },
    runner_metadata: metadata, interaction: { phase: "ended",
      chat_return: { status: "failed", error: "Historical chat must not retain this failure" } } }, "failed");
  const original = f.store.task("original");
  const refresh = nativeControls(t, f.root);
  const controls = createMonitorControls(f.store);
  const options = { store: f.store, config: { agentId: "perf", repositoryProfile: "1js" },
    task: original, workspace: f.workspace, capacity: async () => ({ holding: null }), controls,
    readProfile: () => ({ purpose: "engineering", remoteRoot: "/workspaces/1JS", workspace: f.workspace }) };
  await recoverNativeInvestigation(options);
  await controls.jobs();
  refresh();
  const command = fs.readdirSync(path.join(f.root, "controls", "commands"))[0];
  const receipt = controls.receipt(command.slice(0, -5));
  assert.equal(receipt?.result?.status, "accepted", JSON.stringify(receipt));
  const task = f.store.task(original.id);
  assert.equal(task.status, "incoming");
  assert.equal(task.session_id, original.session_id);
  assert.equal(task.prompt, original.prompt);
  assert.deepEqual(task.runner_metadata, { ...metadata, dashboardPrepared: true });
  assert.equal(task.interaction.chat_return, undefined);
  assert.equal(task.interaction.messages.length, 1);
  assert.equal(task.interaction.messages[0].status, "queued");
  assert.equal(f.store.tasks().length, 1);
});
