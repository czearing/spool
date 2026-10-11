import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { createMonitorControls } from "../monitor-controls.mjs";
import { createMonitorHandler } from "../monitor.mjs";

function setup(t) {
  const f = fixture(t);
  mkdirSync(path.join(f.root, "controls"), { recursive: true });
  writeJson(path.join(f.root, "controls", "capabilities.json"),
    { version: 1, statusControl: true, taskControl: true, interactive: false, updatedAt: new Date().toISOString() });
  return { ...f, controls: createMonitorControls(f.store) };
}
const input = (taskId, status, expectedStatus) => ({ id: randomUUID(), kind: "status", taskId, status, expectedStatus });

test("creation works without interactive chat and preserves the assigned reviewer's posting instructions", async t => {
  const f = setup(t);
  assert.equal(f.controls.options().taskEnabled, true);
  assert.equal(f.controls.options().enabled, false);
  const command = { id: randomUUID(), kind: "create", agent: "pr-reviewer",
    title: "Review requested work", prompt: "The complete original assignment.", workspace: "isolated" };
  const submitted = f.controls.submit(command);
  assert.equal(f.controls.submit(command).taskId, submitted.taskId);
  await f.controls.jobs();
  const request = readJson(path.join(f.root, "controls", "requests", `${command.id}.json`));
  assert.equal(request.agent, "pr-reviewer");
  assert.equal(request.taskId, submitted.taskId);
  assert.ok(existsSync(request.workspace));
  assert.match(request.prompt, /^The complete original assignment\./);
  assert.match(request.prompt, /All original review, posting, approval/);
  assert.doesNotMatch(request.prompt, /Do not post PR comments|Work item history/);
  assert.equal(f.controls.receipt(command.id).status, "submitted");
  assert.equal(f.store.task(submitted.taskId), null, "Only the native daemon creates the task");
});

test("assignment is available without live chat and rejects invalid or paused handoffs", t => {
  const f = setup(t);
  f.put({ id: "one", agent: "perf" }, "incoming");
  f.put({ id: "past", agent: "perf" }, "completed");
  const command = { id: randomUUID(), kind: "handoff", taskId: "one",
    agent: "software-engineer", message: "Assigned from the Tasks view." };
  f.controls.submit(command);
  assert.equal(f.store.task("one").agent, "perf", "Only the daemon changes assignment");
  assert.equal(readJson(path.join(f.root, "controls", "requests", `${command.id}.json`)).agent, "software-engineer");
  assert.throws(() => f.controls.submit({ ...command, id: randomUUID(), taskId: "past" }), /Reopen/);
  assert.throws(() => f.controls.submit({ ...command, id: randomUUID(), agent: "perf" }), /already owns/);
  mkdirSync(path.join(f.root, "controls", "paused"), { recursive: true });
  writeFileSync(path.join(f.root, "controls", "paused", "software-engineer"), "operator");
  assert.throws(() => f.controls.submit({ ...command, id: randomUUID() }), /paused/);
});

test("board controls keep exactly four statuses and reject stale, paused and unsupported actions", t => {
  const f = setup(t);
  f.put({ id: "one", agent: "perf" }, "failed");
  assert.equal(f.controls.options().statusEnabled, true);
  assert.equal(f.controls.options().enabled, false);
  for (const status of ["todo", "blocked", "backlog", "done", "cancelled", "in_review"]) {
    assert.throws(() => f.controls.submit(input("one", status, "failed")), /Unknown/);
  }
  assert.throws(() => f.controls.submit(input("one", "completed", "incoming")), /state changed/);
  assert.throws(() => f.controls.submit({ ...input("one", "completed", "failed"), metadata: {} }), /Invalid operator action/);
  assert.throws(() => f.controls.submit({ id: randomUUID(), kind: "interrupt", taskId: "one" }), /not online/);
  mkdirSync(path.join(f.root, "controls", "paused"), { recursive: true });
  writeFileSync(path.join(f.root, "controls", "paused", "perf"), "operator");
  assert.throws(() => f.controls.submit(input("one", "incoming", "failed")), /paused/);
});

test("moving a running card requests native stop without prematurely moving queue files", t => {
  const f = setup(t);
  f.put({ id: "one", session_id: randomUUID() }, "in_progress");
  const command = input("one", "completed", "in_progress");
  f.controls.submit(command);
  f.controls.submit(command);
  assert.equal(f.store.task("one").status, "in_progress");
  const request = readJson(path.join(f.root, "controls", "requests", `${command.id}.json`));
  assert.equal(request.status, "completed");
  assert.equal(request.expectedStatus, "in_progress");
  assert.throws(() => f.controls.submit({ ...command, status: "failed" }), /reused/);
});

test("reopening an isolated task retains original identity, waits for ownership, and journals preparation", async t => {
  const f = setup(t), session = randomUUID();
  f.put({ id: "one", agent: "perf", session_id: session, prompt: "Original instructions" }, "failed");
  f.put({ id: "other", agent: "perf" }, "in_progress");
  const command = input("one", "incoming", "failed");
  f.controls.submit(command);
  await f.controls.jobs();
  assert.equal(f.controls.receipt(command.id).status, "waiting");
  assert.equal(existsSync(path.join(f.root, "controls", "requests", `${command.id}.json`)), false);
  const { unlinkSync } = await import("node:fs");
  unlinkSync(path.join(f.root, "queues", "in_progress", "other.json"));
  await f.controls.jobs();
  const request = readJson(path.join(f.root, "controls", "requests", `${command.id}.json`));
  assert.equal(request.taskId, "one");
  assert.equal(request.metadata.dashboardPrepared, true);
  assert.equal(f.store.task("one").session_id, session);
  assert.equal(f.store.task("one").prompt, "Original instructions");
  assert.equal(f.store.task("one").status, "failed", "Only the daemon owns queue transitions");
});

test("board writes require same-origin JSON and current token, and survive renderer restart via command identity", async t => {
  const f = setup(t);
  f.put({ id: "one" }, "completed");
  const client = { request: async message => message.operation === "options" ? f.controls.options()
    : message.operation === "submit" ? f.controls.submit(message.input) : f.controls.receipt(message.command) };
  async function request(handler, url, method = "GET", headers = {}, input) {
    let response;
    await handler({ url, method, headers, body: input && JSON.stringify(input) },
      { writeHead(code) { response = { code }; }, end(body) { response.body = body; } });
    return response;
  }
  const handler = createMonitorHandler(client);
  const token = JSON.parse((await request(handler, "/api/monitor/control-options")).body).token;
  const command = input("one", "failed", "completed");
  const headers = { host: "127.0.0.1:8261", origin: "http://127.0.0.1:8261", "content-type": "application/json", "x-spool-token": token };
  assert.equal((await request(handler, "/api/monitor/control", "POST", { ...headers, origin: "https://evil.invalid" }, command)).code, 403);
  assert.equal((await request(handler, "/api/monitor/control", "POST", headers, command)).code, 202);
  const restarted = createMonitorHandler(client);
  assert.equal((await request(restarted, "/api/monitor/control", "POST", headers, command)).code, 403);
  headers["x-spool-token"] = JSON.parse((await request(restarted, "/api/monitor/control-options")).body).token;
  assert.equal((await request(restarted, "/api/monitor/control", "POST", headers, command)).code, 202);
});
