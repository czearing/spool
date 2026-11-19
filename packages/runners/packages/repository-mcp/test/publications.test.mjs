import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { publicationContext, publicationFile, readPublication, readPublications, recordPublication } from "../../bohemia-agent-tooling/src/publications.js";
import { resolveSpoolCreator } from "../../../bridge/creator-routing.mjs";
import { publicationForTask, publicationsForProject, taskHasPublication } from "../../../bridge/publications.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-publications-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "publications");
  const descriptor = { version: 1, projectRoot: root, taskId: "task-1", agent: "software-engineer",
    workspace: root, sessionId: randomUUID(), providerToken: `spool-provider-${randomUUID()}` };
  const contextFile = path.join(root, "controls", "executions", `${descriptor.taskId}.json`);
  const taskFile = path.join(root, "queues", "in_progress", `${descriptor.taskId}.json`);
  const save = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data));
  };
  const task = { id: descriptor.taskId, agent: descriptor.agent, session_id: descriptor.sessionId,
    workspace: root, prompt: "Generic work, not limited to PRs", provider: { token: descriptor.providerToken },
    turns: 0, status: "in_progress" };
  save(contextFile, descriptor); save(taskFile, task);
  const environment = { SPOOL_EXECUTION_CONTEXT: contextFile, SPOOL_PROVIDER_TOKEN: descriptor.providerToken,
    REPOSITORY_MCP_PUBLICATIONS: directory };
  const result = { ready: true, pullRequestId: 42, url: "https://office.visualstudio.com/OC/_git/1js/pullrequest/42",
    commit: "a".repeat(40), targetCommit: "b".repeat(40), targetBranch: "master" };
  const context = publicationContext(environment);
  const store = { root, records: path.join(root, ".runner-receipts"), publicationDirectory: directory,
    task: id => id === task.id ? task : null, metadata: () => null,
    validateAgent: agent => assert.equal(agent, task.agent) };
  return { root, directory, descriptor, contextFile, task, taskFile, save, environment, result, context, store,
    publish: (fields = {}, options) => recordPublication({ context, result, branch: "user/example/library", repoRoot: root, ...fields }, options) };
}

test("one task and conversation publishes multiple PRs and repositories without changing the task", async t => {
  const f = fixture(t), before = fs.readFileSync(f.taskFile, "utf8");
  await f.publish();
  await f.publish({ result: { ...f.result, pullRequestId: 43, url: f.result.url.replace(/42$/, "43") }, branch: "user/example/another" });
  await f.publish({ result: { ...f.result, url: f.result.url.replace("/1js/", "/office-bohemia/") } });
  const records = readPublications(f.directory);
  assert.equal(records.length, 3);
  assert.ok(records.every(record => record.taskId === f.task.id && record.sessionId === f.task.session_id));
  assert.equal(fs.readFileSync(f.taskFile, "utf8"), before);
  assert.ok(!JSON.stringify(records).includes(f.descriptor.providerToken));
});

test("PR updater resumes the exact publishing conversation and accepts equivalent Azure URL forms", async t => {
  const f = fixture(t);
  await f.publish();
  const owner = resolveSpoolCreator(f.store, { id: "42", branch: "user/example/library",
    url: "https://dev.azure.com/office/OC/_git/1js/pullrequest/42" });
  assert.equal(owner.task.id, f.task.id);
  assert.equal(owner.sessionId, f.descriptor.sessionId);
  assert.equal(owner.task.session_id, f.descriptor.sessionId);
  f.task.session_id = randomUUID();
  assert.throws(() => resolveSpoolCreator(f.store, { id: "42", branch: owner.branch, url: f.result.url }), /session/);
});

test("the latest successful publishing conversation owns routing, not a task-global PR reservation", async t => {
  const f = fixture(t);
  await f.publish();
  const next = { ...f.context, taskId: "task-2", sessionId: randomUUID(), agent: "software-engineer-2" };
  await f.publish({ context: next });
  const owner = readPublication(f.result.url, f.directory);
  assert.equal(owner.taskId, next.taskId);
  assert.equal(owner.sessionId, next.sessionId);
  assert.equal(owner.publications.length, 2);
  assert.equal(owner.publications[0].sessionId, f.context.sessionId);
});

test("non-PR work exposes only generic execution identity and creates no publication files", t => {
  const f = fixture(t);
  assert.equal(publicationContext(f.environment).sessionId, f.descriptor.sessionId);
  assert.ok(!fs.existsSync(f.directory));
  assert.ok(!fs.existsSync(path.join(f.root, ".runner-receipts")));
  assert.equal(f.context.branch, undefined);
});

for (const change of [{ agent: "another" }, { session_id: randomUUID() }, { provider: { token: "wrong" } }])
  test(`stale or foreign executions cannot register publications: ${JSON.stringify(change)}`, t => {
    const f = fixture(t);
    f.save(f.taskFile, { ...f.task, ...change });
    assert.throws(() => publicationContext(f.environment), /context/);
    assert.ok(!fs.existsSync(f.directory));
  });

test("invalid results and a changed source branch do not overwrite verified routing", async t => {
  const f = fixture(t);
  await f.publish();
  const before = fs.readFileSync(publicationFile(f.result.url, f.directory), "utf8");
  for (const result of [{ ...f.result, ready: false }, { ...f.result, commit: "unknown" },
    { ...f.result, url: f.result.url.replace(/42$/, "43") }])
    await assert.rejects(f.publish({ result }));
  await assert.rejects(f.publish({ branch: "wrong" }), /source branch/);
  assert.equal(fs.readFileSync(publicationFile(f.result.url, f.directory), "utf8"), before);
});

test("concurrent registrations and repeated successful calls remain durable and idempotent", async t => {
  const f = fixture(t);
  await Promise.all(Array.from({ length: 5 }, () => f.publish()));
  assert.equal(readPublications(f.directory).length, 1);
  assert.equal(readPublication(f.result.url, f.directory).publications.length, 1);
  await assert.rejects(f.publish({ context: { ...f.context, sessionId: randomUUID() } },
    { write() { throw new Error("storage unavailable"); } }), /storage unavailable/);
  assert.equal(readPublication(f.result.url, f.directory).sessionId, f.context.sessionId);
});

test("standalone Copilot conversations are recorded without fabricating a task or agent", async t => {
  const f = fixture(t);
  const context = publicationContext({ COPILOT_SESSION_ID: randomUUID(), REPOSITORY_MCP_PUBLICATIONS: f.directory });
  await f.publish({ context });
  const owner = readPublication(f.result.url, f.directory);
  assert.equal(owner.sessionId, context.sessionId);
  assert.equal(owner.taskId, null);
  assert.equal(owner.agent, null);
});

test("a reserved publisher resumes its first conversation without native PR ownership writes", async t => {
  const f = fixture(t);
  f.task.session_id = null;
  f.task.deferred_session = true;
  await f.publish({ context: { ...f.context, sessionId: null, deferred: true } });
  assert.equal(publicationForTask(f.store, f.task.id).sessionId, null);
  f.task.session_id = randomUUID();
  f.save(f.contextFile, { ...f.descriptor, sessionId: f.task.session_id });
  const publication = publicationForTask(f.store, f.task.id);
  assert.equal(publication.sessionId, f.task.session_id);
  const routed = resolveSpoolCreator(f.store, { id: "42", branch: publication.branch, url: f.result.url });
  assert.equal(routed.sessionId, f.task.session_id);
  assert.equal(readPublication(f.result.url, f.directory).sessionId, null);
  f.save(f.contextFile, { ...f.descriptor, sessionId: randomUUID() });
  assert.throws(() => publicationForTask(f.store, f.task.id), /execution identity/);
});

test("a completed conversation cannot register another publication", t => {
  const f = fixture(t);
  fs.rmSync(f.taskFile);
  f.save(path.join(f.root, "queues", "completed", `${f.task.id}.json`), { ...f.task, status: "completed" });
  assert.throws(() => publicationContext(f.environment), /no longer matches/);
  assert.ok(!fs.existsSync(f.directory));
});

test("a newer publisher supersedes historical ownership, including a standalone conversation", async t => {
  const f = fixture(t);
  const previous = await f.publish();
  f.save(path.join(f.store.records, "native-creators", `${f.task.id}.json`), previous);
  await f.publish({ context: { ...f.context, taskId: "another-task", sessionId: randomUUID() } });
  assert.equal(publicationForTask(f.store, f.task.id, { prId: previous.prId }), null);
  assert.equal(taskHasPublication(f.store, f.task.id), false);
  await f.publish({ context: { ...f.context, taskId: null, agent: null, projectRoot: null, sessionId: randomUUID() } });
  assert.deepEqual(publicationsForProject(f.store), []);
  assert.equal(publicationForTask(f.store, f.task.id, { prUrl: f.result.url }), null);
  assert.equal(taskHasPublication(f.store, f.task.id), false);
});

test("historical recovery cannot replace a concurrent successful publisher", async t => {
  const f = fixture(t), current = { ...f.context, taskId: "current", sessionId: randomUUID() };
  await Promise.all([f.publish({ context: current }), f.publish({}, { onlyIfAbsent: true })]);
  assert.equal(readPublication(f.result.url, f.directory).sessionId, current.sessionId);
});
