import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { nativeControls } from "./native-controls-fixture.mjs";
import { createMonitorControls } from "../monitor-controls.mjs";
import { readJson, writeJson } from "../spool-store.mjs";

const input = (f, key = "followup") => ({ key, agent: "pr-updater", title: "Follow up",
  prompt: "Only new feedback", workspace: f.workspace, resumeId: "original",
  metadata: { preparation: f.preparation, runner: "fixture" } });
const original = f => f.put({ id: "original", session_id: "saved", prompt: "Original assignment",
  interaction: { messages: [{ id: "old", text: "Already sent", status: "delivered", created_at: new Date().toISOString() }] } }, "completed");

test("runner uses native message acceptance and never rewrites the original prompt or publishes queue files", async t => {
  const f = fixture(t);
  original(f);
  f.store.publish = () => assert.fail("Runner must not republish a continuation");
  const task = await f.store.submit(input(f));
  assert.equal(task.session_id, "saved");
  assert.equal(task.prompt, "Original assignment");
  assert.equal(task.status, "incoming");
  assert.deepEqual(task.interaction.messages.map(message => message.text), ["Already sent", "Only new feedback"]);
  assert.equal(task.interaction.messages[1].status, "queued");
  assert.equal(task.runner_metadata.key, "followup");
  assert.equal(f.store.metadata(task.id).phase, "published");
  const receipt = f.store.receipt("followup");
  assert.ok(receipt.nativeMessageId);
  assert.equal(receipt.phase, "published");
  assert.equal(readJson(path.join(f.root, "controls", "results", `${receipt.nativeMessageId}.json`)).result.status, "accepted");
  assert.equal(existsSync(path.join(f.root, "queues", ".runner-archive")), false);
  assert.equal(existsSync(path.join(f.store.records, "task-original.json")), false);
  assert.equal((await f.store.submit(input(f))).interaction.messages.length, 2);
});

test("lost acknowledgement is recovered from the native task commit without duplicate delivery", async t => {
  const f = fixture(t);
  original(f);
  const task = await f.store.submit(input(f));
  const receipt = f.store.receipt("followup");
  rmSync(path.join(f.root, "controls", "results", `${receipt.nativeMessageId}.json`));
  assert.throws(() => f.store.recoverSubmission("followup"), /acceptance is still pending/);
  assert.equal((await f.store.submit(input(f))).interaction.messages.length, 2);
  assert.equal(f.store.recoverSubmission("followup").task.id, task.id);
  assert.equal(f.store.receipt("followup").phase, "published");
});

test("ordinary chat and runner feedback share native message storage without replacing prepared metadata", async t => {
  const f = fixture(t);
  original(f);
  const task = await f.store.submit(input(f));
  const controls = createMonitorControls(f.store), id = randomUUID();
  controls.submit({ id, kind: "message", taskId: task.id, message: "A question from the chat UI" });
  for (let count = 0; count < 60 && !controls.receipt(id)?.result; count++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(controls.receipt(id).result.status, "accepted");
  const current = f.store.task(task.id);
  assert.equal(current.interaction.messages.at(-1).text, "A question from the chat UI");
  assert.deepEqual(current.runner_metadata, task.runner_metadata);
  assert.equal(current.prompt, "Original assignment");
});

test("runner cannot overwrite pending or uncertain conversation input", async t => {
  const f = fixture(t);
  for (const status of ["queued", "delivering", "delivery_uncertain"]) {
    f.put({ id: "original", session_id: "saved", interaction: {
      messages: [{ id: "previous", text: "Preserve", status, created_at: new Date().toISOString() }] } }, "failed");
    await assert.rejects(f.store.submit(input(f, status)), /pending or uncertain/);
    assert.equal(f.store.task("original").status, "failed");
    assert.equal(f.store.task("original").interaction.messages[0].text, "Preserve");
    assert.equal(f.store.metadata("original"), null);
  }
});

test("old or offline daemons fail explicitly instead of falling back to direct queue mutation", async t => {
  const f = fixture(t, { nativeMessages: false });
  original(f);
  mkdirSync(path.join(f.root, "controls"));
  writeJson(path.join(f.root, "controls", "capabilities.json"), {
    version: 1, interactive: true, messageContinuationVersion: 1, updatedAt: new Date().toISOString(),
  });

  test("a surviving provider blocks runner preparation without publishing a command", async t => {
    const f = fixture(t);
    original(f);
    f.store.processes = () => [{ Name: "copilot.exe", CommandLine: "copilot --resume saved" }];
    await assert.rejects(f.store.submit(input(f)), /owned by Spool task/);
    assert.equal(f.store.task("original").status, "completed");
    assert.equal(f.store.task("original").interaction.messages.length, 1);
  });

  test("a rejected preparation can be corrected under the same submission key without replaying accepted input", async t => {
    const f = fixture(t);
    original(f);
    const rejected = input(f);
    rejected.metadata.preparation = { ...f.preparation, ready: false };
    await assert.rejects(f.store.submit(rejected), /not verified/);
    const firstId = f.store.receipt("followup").nativeMessageId;
    const task = await f.store.submit(input(f));
    assert.notEqual(f.store.receipt("followup").nativeMessageId, firstId);
    assert.equal(task.interaction.messages.length, 2);
    assert.equal((await f.store.submit(input(f))).interaction.messages.length, 2);
    assert.equal(readJson(path.join(f.root, "controls", "results", `${firstId}.json`)).result.status, "failed");
  });
  await assert.rejects(f.store.submit(input(f)), /Update Spool/);
  assert.equal(f.store.task("original").status, "completed");
  assert.equal(f.store.task("original").interaction.messages.length, 1);
});

test("concurrent chat makes stale runner preparation fail without losing either the task or chat message", async t => {
  const f = fixture(t, { nativeMessages: false });
  original(f);
  const refresh = nativeControls(t, f.root), controls = createMonitorControls(f.store);
  const snapshot = f.store.task("original"), chatId = randomUUID(), runnerId = randomUUID();
  controls.submit({ id: chatId, kind: "message", taskId: "original", message: "Keep this new chat message" });
  refresh();
  controls.submit({ id: runnerId, kind: "message", taskId: "original", message: "Stale prepared feedback",
    metadata: { key: "stale", sessionId: "saved", agent: snapshot.agent, workspace: f.workspace,
      expectedUpdatedAt: snapshot.updated_at, metadata: { preparation: f.preparation } } });
  refresh();
  assert.equal(controls.receipt(chatId).result.status, "accepted");
  assert.equal(controls.receipt(runnerId).result.status, "failed");
  assert.equal(f.store.task("original").interaction.messages.at(-1).text, "Keep this new chat message");
  assert.equal(f.store.metadata("original"), null);
  assert.equal(readdirSync(path.join(f.root, "queues", "incoming")).length, 1);
});
