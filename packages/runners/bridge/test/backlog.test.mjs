import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { backlogFixture, item, reviewers } from "./backlog-fixture.mjs";
import { backlogPrompt } from "../backlog.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { withAdmission } from "../admission.mjs";
import { orderWorkItems } from "../backlog-ado.mjs";

test("priority, age, then ID ordering is explicit; missing priority is last", () => {
  const ordered = orderWorkItems([item(4, { priority: null }), item(3, { priority: 2 }),
    item(2), item(1), item(5, { createdAt: "2025-01-01T00:00:00Z" })]);
  assert.deepEqual(ordered.map(item => item.id), [5, 1, 2, 3, 4]);
});
test("one exact minimal work-item prompt is handed directly to the configured native engineer", async t => {
  const f = backlogFixture(t), result = await f.scan(), task = f.store.task(result.taskId);
  assert.equal(result.workItemId, 1);
  assert.equal(task.agent, "software-engineer-2");
  assert.equal(task.prompt, "Investigate this work item https://office.visualstudio.com/OC/_workitems/edit/1 in midgard/packages/library-module-exp-homepage/src/unified-library, not the standalone TanStack app. Create a PR, attach it to the work item, and assign Nate Tan, Torre Taylor, Justin Fernald as reviewers.");
  assert.equal(task.prompt, backlogPrompt(f.client.itemUrl(1), reviewers));
  assert.deepEqual(f.calls.prepare, []);
  assert.equal(f.store.metadata(task.id).preparation, undefined);
  assert.equal(f.store.metadata(task.id).handoff.workItem.id, 1);
  assert.equal((await f.scan()).dispatched, 0);
  assert.equal(f.calls.prepare.length, 0);
});
for (const type of ["Task", "Bug", "Product Backlog Item"]) test(`assigned ${type} children are admitted without a Bug-only filter`, async t => {
  const f = backlogFixture(t, { items: [item(1, { type })] });
  assert.equal((await f.scan()).workItemId, 1);
});
for (const count of [3, 4]) test(`${count} active owned PRs, including drafts, prevent another preparation`, async t => {
  const f = backlogFixture(t);
  for (let id = 1; id <= count; id++) f.prs.set(id, { pullRequestId: id, status: "active",
    isDraft: id === 2, sourceRefName: `refs/heads/user/calebzearing/library-backlog-old-${id}` });
  assert.match((await f.scan()).holding, new RegExp(`${count}/3`));
  assert.equal(f.calls.prepare.length, 0);
});
test("a PR-cap race before delivery holds and retries the same undelivered item without repository work", async t => {
  const f = backlogFixture(t);
  const original = f.client.listPullRequests;
  let count = 0;
  f.client.listPullRequests = async (...args) => ++count === 2 ? [1, 2, 3].map(id =>
    ({ id: String(id), status: "active", branch: `user/calebzearing/library-backlog-${id}` })) : original(...args);
  assert.match((await f.scan()).holding, /3\/3/);
  assert.equal(f.store.tasks().length, 0);
  assert.equal((await f.scan()).dispatched, 1);
  assert.equal(f.store.metadata(f.store.tasks()[0].id).preparation, undefined);
  assert.deepEqual(f.calls.prepare, []);
});
test("busy, paused, and surviving-provider ownership prevent preparation", async t => {
  const f = backlogFixture(t);
  f.store.isPaused = () => true;
  assert.match((await f.scan()).holding, /paused/);
  f.store.isPaused = () => false;
  const first = await f.scan();
  f.finish(first.taskId);
  const task = f.store.task(first.taskId);
  f.put({ ...task, session_id: "still-running" }, "completed");
  f.store.processes = () => [{ Name: "node.exe", CommandLine: "--session-id still-running" }];
  assert.equal((await f.scan()).dispatched, 0);
  assert.equal(f.calls.prepare.length, 0);
});
test("stable submissions recover a crash after task delivery without preparing or dispatching twice", async t => {
  const f = backlogFixture(t), first = await f.scan(), file = path.join(f.runtime, "backlog.json");
  const state = readJson(file); delete state.entries[0].taskId; writeJson(file, state);
  await f.scan();
  assert.equal(readJson(file).entries[0].taskId, first.taskId);
  assert.equal(f.store.tasks().length, 1);
  assert.equal(f.calls.prepare.length, 0);
});
test("configuration ownership and receipt corruption fail closed", async t => {
  const f = backlogFixture(t), first = await f.scan(), file = path.join(f.runtime, "backlog.json");
  const state = readJson(file);
  state.scope.parent = 4; writeJson(file, state);
  await assert.rejects(f.scan(), /ownership/);
  state.scope.parent = 12284752; state.entries[0].taskId = "different"; writeJson(file, state);
  await assert.rejects(f.scan(), /receipt/);
  assert.equal(f.store.tasks().length, 1);
  assert.ok(first.taskId);
});
for (const patch of [{ assignedTo: "someone@example.test" }, { parentId: 7 }, { state: "Closed" }])
  test(`eligibility changes during preparation do not reach the agent: ${JSON.stringify(patch)}`, async t => {
    const f = backlogFixture(t);
    const original = f.client.item; let reads = 0;
    f.client.item = async id => ({ ...await original(id), ...(reads++ ? patch : {}) });
    assert.match((await f.scan()).holding, /eligibility changed/);
    assert.equal(f.store.tasks().length, 0);
  });
test("an existing PR slot is not duplicated; the next eligible item is selected", async t => {
  const f = backlogFixture(t);
  f.items.get(1).relations.push({ rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/project%2Frepo%2F99" });
  assert.equal((await f.scan()).workItemId, 2);
});
test("a work item already handed to another engineer is not redispatched during migration", async t => {
  const f = backlogFixture(t);
  f.put({ id: "original-work", agent: "software-engineer" }, "failed");
  writeJson(path.join(f.store.records, "task-original-work.json"), {
    handoff: { workItem: { id: 1, project: "OC", parent: 12284752 } },
  });
  assert.equal((await f.scan()).workItemId, 2);
});
test("API and reviewer failures are surfaced without delivering a task or preparing a repository", async t => {
  const f = backlogFixture(t);
  f.client.list = async () => { throw new Error("ADO unavailable"); };
  await assert.rejects(f.scan(), /ADO unavailable/);
  f.client.list = async () => [item(1)];
  f.client.verifyReviewers = async () => { throw new Error("Reviewer unavailable"); };
  await assert.rejects(f.scan(), /Reviewer unavailable/);
  assert.equal(f.calls.prepare.length, 0);
  const native = backlogFixture(t, { prepare: async () => { throw new Error("Must not prepare"); } });
  assert.equal((await native.scan()).dispatched, 1);
  assert.equal(native.store.metadata(native.store.tasks()[0].id).preparation, undefined);
});
for (const status of ["completed", "failed"]) test(`${status} task without a verified PR holds instead of silently losing the item`, async t => {
  const f = backlogFixture(t), first = await f.scan();
  f.finish(first.taskId, status);
  assert.match((await f.scan()).holding, status === "failed" ? /failed/ : /no verified PR/);
  assert.equal(f.calls.prepare.length, 0);
});
test("fresh PR reconciliation links the artifact, preserves other links, and adds reviewers", async t => {
  const f = backlogFixture(t), first = await f.scan(), pr = f.publish(first.taskId);
  f.items.get(1).relations.push({ rel: "System.LinkTypes.Related", url: "keep" });
  await f.scan(); await f.scan();
  assert.equal(f.calls.link.length, 1);
  assert.equal(f.calls.reviewers.length, 2);
  assert.equal(f.items.get(1).relations[0].url, "keep");
  assert.equal(f.calls.close.length, 0);
  assert.equal(readJson(path.join(f.runtime, "backlog.json")).entries[0].prId, pr.pullRequestId);
});
test("creator-updater continuation metadata does not destroy the original backlog association", async t => {
  const f = backlogFixture(t), first = await f.scan();
  f.finish(first.taskId);
  f.publish(first.taskId, { status: "completed" });
  const original = f.store.metadata(first.taskId);
  writeJson(path.join(f.store.records, `task-${first.taskId}.json`), {
    runner: "pr-updater", preparation: { ...original.preparation, commit: "d".repeat(40) },
    creator: { taskId: first.taskId }, contract: { prId: "1" },
  });
  assert.equal((await f.scan()).workItemId, 2);
  assert.deepEqual(f.calls.close, [1]);
});
test("verified merge closes exactly its associated assigned item, persists proof, and releases another task", async t => {
  const f = backlogFixture(t), first = await f.scan();
  f.finish(first.taskId);
  const pr = f.publish(first.taskId, { status: "completed" });
  const second = await f.scan();
  assert.equal(second.workItemId, 2);
  assert.deepEqual(f.calls.close, [1]);
  const entry = readJson(path.join(f.runtime, "backlog.json")).entries[0];
  assert.equal(entry.mergeCommit, pr.lastMergeCommit.commitId);
  assert.equal(entry.closedRevision, f.items.get(1).rev);
  await f.scan();
  assert.deepEqual(f.calls.close, [1]);
});
for (const patch of [{ status: "active" }, { status: "abandoned" }, { mergeStatus: "queued" },
  { lastMergeCommit: undefined }, { lastMergeSourceCommit: undefined }, { isDraft: true }])
  test(`unverified merges never close work items: ${JSON.stringify(patch)}`, async t => {
    const f = backlogFixture(t), first = await f.scan();
    f.finish(first.taskId);
    f.publish(first.taskId, { status: "completed", ...patch });
    await f.scan();
    assert.equal(f.calls.close.length, 0);
  });
for (const patch of [{ assignedTo: "someone@example.test" }, { parentId: 7 }, { project: "Other" }])
  test(`reassignment or backlog removal prevents linkage and closure: ${JSON.stringify(patch)}`, async t => {
    const f = backlogFixture(t), first = await f.scan();
    f.publish(first.taskId, { status: "completed" });
    Object.assign(f.items.get(1), patch);
    assert.match((await f.scan()).holding, /no longer assigned/);
    assert.equal(f.calls.link.length, 0);
    assert.equal(f.calls.close.length, 0);
  });
for (const patch of [{ createdBy: { id: "other" } }, { targetRefName: "refs/heads/other" },
  { repository: { id: "wrong", project: { id: "project-id" } } }])
  test(`wrong PR ownership/repository/target is rejected: ${JSON.stringify(patch)}`, async t => {
    const f = backlogFixture(t), first = await f.scan();
    f.publish(first.taskId, { status: "completed", ...patch });
    await assert.rejects(f.scan(), /ownership\/scope/);
    assert.equal(f.calls.close.length, 0);
  });
test("reassignment immediately before closure is detected", async t => {
  const f = backlogFixture(t), first = await f.scan();
  f.publish(first.taskId, { status: "completed" });
  const original = f.client.item; let reads = 0;
  f.client.item = async id => ({ ...await original(id), ...(++reads > 1 ? { assignedTo: "other" } : {}) });
  await assert.rejects(f.scan(), /changed before closing/);
  assert.equal(f.calls.close.length, 0);
});
test("source merge evidence disappearing on the final PR read prevents closure", async t => {
  const f = backlogFixture(t), first = await f.scan();
  f.publish(first.taskId, { status: "completed" });
  const getPr = f.client.getPr; let reads = 0;
  f.client.getPr = async id => ({ ...await getPr(id), ...(++reads > 2 ? { lastMergeSourceCommit: undefined } : {}) });
  await assert.rejects(f.scan(), /changed before closing/);
  assert.equal(f.calls.close.length, 0);
});
test("closure conflicts surface and retry through fresh reads without duplicating links", async t => {
  const f = backlogFixture(t), first = await f.scan();
  f.publish(first.taskId, { status: "completed" });
  const close = f.client.close;
  f.client.close = async () => { throw Object.assign(new Error("ADO 412 revision changed"), { status: 412 }); };
  await assert.rejects(f.scan(), /revision changed/);
  f.client.close = close;
  await f.scan();
  assert.equal(f.calls.link.length, 1);
  assert.deepEqual(f.calls.close, [1]);
});
test("shared admission serializes overlapping backlog scans", async t => {
  const f = backlogFixture(t);
  const results = await Promise.all([1, 2].map(() =>
    withAdmission(f.store.root, f.config.agentId, f.scan, f.workspace)));
  assert.equal(results.filter(result => result.dispatched === 1).length, 1);
  assert.equal(f.store.tasks().length, 1);
});
