import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fixture, providerEnvironment } from "./fixtures.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { createMonitorControls } from "../monitor-controls.mjs";
import { continuationMessage } from "../message-payload.mjs";
import { createSpoolQueue } from "../queue.mjs";
import { startApplicationRunners } from "../application.mjs";

test("operator messages default successful conversations to completed without explicit status tools", { timeout: 60000 }, async t => {
  const binary = process.env.SPOOL_TEST_BINARY ||
    fileURLToPath(new URL("../../../../target/debug/spool.exe", import.meta.url));
  assert.ok(existsSync(binary), "Build native Spool or set SPOOL_TEST_BINARY");
  const cleanup = [], f = fixture({ after: fn => cleanup.push(fn) }, { nativeMessages: false });
  const provider = path.join(f.root, "active-provider.cjs"), protocol = path.join(f.root, "active-protocol.jsonl");
  writeFileSync(provider, `
const fs = require("node:fs"), path = require("node:path");
const root = process.env.SPOOL_NATIVE_MESSAGE_FIXTURE, session = "active-fixture-session";
if (!root || !fs.existsSync(path.join(root, "active-fixture"))) throw Error("Not an isolated fixture");
let active;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:"2.0",...value})+"\\n");
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(path.join(root,"active-protocol.jsonl"), JSON.stringify({...request,receivedAt:Date.now()})+"\\n");
  if(request.method === "initialize") send({id:request.id,result:{agentCapabilities:{loadSession:true}}});
  else if(request.method === "session/new")
    send({id:request.id,result:{sessionId:session,models:{currentModelId:"fixture-model"}}});
  else if(request.method === "session/prompt") {
    if(active) throw Error("Concurrent provider turns");
    active = request.id;
    send({method:"session/update",params:{sessionId:session,update:{
      sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Input received"}}}});
    if(request.params.prompt.some(value => value.text === "Finish fixture")) {
      send({id:active,result:{stopReason:"end_turn",usage:{inputTokens:0,outputTokens:0}}}); active=undefined;
    }
  } else if(request.method === "session/cancel") {
    if(!active) throw Error("No active turn to cancel");
    send({id:active,result:{stopReason:"cancelled",usage:{inputTokens:0,outputTokens:0}}}); active=undefined;
  }
});
`);
  writeFileSync(path.join(f.root, "active-fixture"), "No real provider");
  writeFileSync(path.join(f.root, "agents", "pr-updater.md"), "---\nmodel: fixture-model\n---\nFixture.");
  writeJson(path.join(f.root, "spool.json"), { version: 1, defaultModel: "fixture-model", autopilot: false, copilotProviders: {
    "pr-updater": { command: process.execPath, args: [provider], workingDirectory: "/workspaces/fixture" },
  } });
  const daemon = spawn(binary, ["--root", f.root, "daemon"], { cwd: f.root, windowsHide: true,
    env: { ...process.env, SPOOL_INTERACTIVE_ACP: "1", SPOOL_NATIVE_MESSAGE_FIXTURE: f.root },
    stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  for (const stream of [daemon.stdout, daemon.stderr])
    stream.on("data", bytes => { diagnostics = (diagnostics + bytes).slice(-4096); });
  const records = () => existsSync(protocol)
    ? readFileSync(protocol, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const until = async check => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (daemon.exitCode !== null) throw Error(`Fixture daemon exited: ${diagnostics}`);
      const value = check(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const task = f.store.task("original");
    throw Error(`Timed out waiting for fixture provider: ${diagnostics}\n` +
      JSON.stringify({ status: task?.status, error: task?.error, phase: task?.interaction?.phase }));
  };
  try {
    await until(() => readJson(path.join(f.root, "controls", "capabilities.json"))?.interactive);
    f.put({ id: "original", runner_metadata: { runner: "manual-dashboard", preparation: { prId: 123 } } });
    await until(() => records().some(row => row.method === "session/prompt"));
    const controls = createMonitorControls(f.store), latencies = [];
    for (let index = 0; index < 12; index++) {
      await new Promise(resolve => setTimeout(resolve, [17, 83, 41, 113][index % 4]));
      const id = randomUUID(), message = `Follow-up ${index}`, started = Date.now();
      const input = { id, kind: "message", taskId: "original", message };
      controls.submit(input);
      const received = await until(() => records().find(row => row.method === "session/prompt" &&
        row.params.prompt.some(value => value.text === message)));
      latencies.push(received.receivedAt - started);
      await until(() => f.store.task("original")?.interaction.messages.find(row => row.id === id)?.status === "delivered");
      assert.equal(controls.receipt(id)?.result?.status, "accepted");
      controls.submit(input);
    }
    const queue = createSpoolQueue(f.store, { agent: "pr-updater", workspace: f.workspace, runner: "pr-reviewer",
      identity: "manual-dashboard" });
    const update = { prId: 123, sourceChanged: true, targetChanged: true,
      previousSourceCommit: "a".repeat(40), sourceCommit: "b".repeat(40),
      previousTargetCommit: "c".repeat(40), targetCommit: "d".repeat(40) };
    assert.equal(await queue.notifyIssue("original", update), false, "Queued is not yet acknowledged");
    await until(() => records().find(row => row.method === "session/prompt" &&
      row.params.prompt.some(value => value.text?.startsWith("Heads up: PR 123 was updated."))));
    await until(() => f.store.task("original")?.interaction.messages.some(row =>
      row.text.startsWith("Heads up: PR 123 was updated.") && row.status === "delivered"));
    assert.equal(await queue.notifyIssue("original", update), true);
    assert.equal(f.store.task("original").status, "in_progress");
    controls.submit({ id: randomUUID(), kind: "message", taskId: "original", message: "Finish fixture" });
    await until(() => f.store.task("original")?.status === "completed" && !f.store.task("original").provider);
    assert.equal(f.store.task("original").error, null);
    const prompts = records().filter(row => row.method === "session/prompt");
    assert.equal(prompts.length, 15);
    assert.ok(prompts.every(row => row.params.sessionId === "active-fixture-session"));
    assert.equal(records().filter(row => row.method === "session/new").length, 1);
    assert.equal(records().filter(row => row.method === "session/cancel").length, 14);
    for (let index = 0; index < 12; index++)
      assert.equal(prompts.filter(row => row.params.prompt.some(value => value.text === `Follow-up ${index}`)).length, 1);
    latencies.sort((a, b) => a - b);
    t.diagnostic(`Actual active-provider input: median ${latencies[6]}ms, p95 ${latencies[11]}ms; ${JSON.stringify(latencies)}`);
  } finally {
    const active = f.store.tasks().filter(task => task.provider);
    if (active.length) throw Error(`Isolated provider left uninterrupted for inspection: ${f.root}`);
    if (daemon.exitCode === null) { const exited = once(daemon, "exit"); daemon.kill(); await exited; }
    for (const finish of cleanup) finish();
  }
});

for (const native of [false, true])
test(`runner and chat messages restore one conversation through ${native ? "durable native" : "local"} admission`, { timeout: 90000 }, async t => {
  const binary = process.env.SPOOL_TEST_BINARY ||
    fileURLToPath(new URL("../../../../target/debug/spool.exe", import.meta.url));
  assert.ok(existsSync(binary), "Build native Spool or set SPOOL_TEST_BINARY");
  const cleanup = [], f = fixture({ after: fn => cleanup.push(fn) }, { nativeMessages: false });
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid", ...args], { cwd: f.workspace, windowsHide: true, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "fixture");
  git("commit", "-q", "--allow-empty", "-m", "Fixture");
  f.preparation.commit = git("rev-parse", "HEAD");
  const bin = path.join(f.root, "bin"), loader = path.join(bin, "node_modules", "@github", "copilot", "npm-loader.js");
  mkdirSync(path.dirname(loader), { recursive: true });
  copyFileSync(path.join(import.meta.dirname, "fixtures", "native-message-provider.cjs"), loader);
  writeFileSync(path.join(f.root, "native-message-fixture"), "No production tasks or real providers");
  writeFileSync(path.join(f.root, "agents", "pr-updater.md"), "---\nmodel: fixture-model\n---\nFixture role.");
  const env = providerEnvironment(bin, { SPOOL_TEST_BINARY: binary, SPOOL_INTERACTIVE_ACP: "1",
    SPOOL_NATIVE_MESSAGE_FIXTURE: f.root });
  writeJson(path.join(f.root, "spool.json"), {
    version: 1, defaultModel: "fixture-model", autopilot: false, ...(native ? { copilotProviders: {
      "pr-updater": { command: process.execPath, args: [loader], workingDirectory: "/workspaces/native-fixture" },
    } } : {}),
  });
  const daemon = spawn(binary, ["--root", f.root, "daemon"], {
    cwd: f.root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  for (const stream of [daemon.stdout, daemon.stderr]) stream.on("data", bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
  const registry = path.join(f.root, "projects.json");
  writeJson(registry, { version: 1, projects: [{ id: "fixture", root: f.root }] });
  const application = native ? await startApplicationRunners(registry) : null;
  const until = async (check, label) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (daemon.exitCode !== null) throw new Error(`Daemon exited: ${diagnostics}`);
      const value = check(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}\n${diagnostics}`);
  };
  const finished = turns => {
    const task = f.store.task("original");
    if (task?.status === "failed" && task.interaction.phase !== "waiting_preparation") throw new Error(task.error);
    return task?.status === "completed" && task.turns === turns && !task.provider && task;
  };
  try {
    await until(() => readJson(path.join(f.root, "controls", "capabilities.json"))?.preparedMessageVersion === 1, "native capability");
    f.put({ id: "original", prompt: "Original assignment must stay unchanged" });
    const first = await until(() => finished(1), "first provider completion");
    const message = "Fix the new PR finding only.";
    await f.store.submit({ key: "pr-feedback", agent: "pr-updater", resumeId: "original", workspace: f.workspace,
      title: "Ignored follow-up title", prompt: message, metadata: { preparation: f.preparation, runner: "pr-updater",
        contract: { submissionId: "pr-feedback", identifier: "original", agent: "pr-updater",
          cwd: f.workspace, branch: f.preparation.branch, fingerprint: "review-v1" } } });
    const second = await until(() => finished(2), "runner provider completion");
    const config = structuredClone(second.session_config);
    config.mcp.mcpServers.spool.command = path.join(f.root, "obsolete-spool.exe");
    f.put({ ...second, session_config: config }, "completed");
    git("checkout", "-q", "-b", "chat-branch");
    const controls = createMonitorControls(f.store), id = randomUUID(), question = "What did you change?";
    const messageStart = performance.now();
    controls.submit({ id, kind: "message", taskId: "original", message: question });
    const third = await until(() => {
      const receipt = controls.receipt(id);
      if (receipt?.result?.status === "failed") throw new Error(JSON.stringify(receipt));
      return finished(3);
    }, "chat provider completion");
    t.diagnostic(`${native ? "Native" : "Local"} cold message reached a complete fixture response in ${Math.round(performance.now() - messageStart)}ms`);
    assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "chat-branch");
    assert.equal(Object.hasOwn(third.session_config, "branch"), false);
    assert.equal(third.session_config.mcp.mcpServers.spool.command, binary);
    assert.equal(third.interaction.chat_return, undefined);
    f.preparation.branch = "chat-branch";
    const large = "# PR update mode\n" + "Keep every finding. ".repeat(5000);
    await f.store.submit({ key: "large-feedback", agent: "pr-updater", resumeId: "original", workspace: f.workspace,
      prompt: large, metadata: { preparation: f.preparation, runner: "pr-updater",
        contract: { submissionId: "large-feedback", identifier: "original", agent: "pr-updater",
          cwd: f.workspace, branch: f.preparation.branch, fingerprint: "review-v2" } } });
    const fourth = await until(() => finished(4), "large runner provider completion");
    assert.equal(first.session_id, second.session_id);
    assert.equal(second.session_id, third.session_id);
    assert.equal(third.session_id, fourth.session_id);
    assert.equal(third.prompt, first.prompt);
    assert.equal(third.title, first.title);
    assert.equal(third.runner_metadata.contract.fingerprint, "review-v1");
    assert.equal(third.interaction.messages.length, 2);
    assert.ok(third.interaction.messages.every(row => row.status === "delivered"));
    const protocol = readFileSync(path.join(f.root, "provider-protocol.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(protocol.filter(row => row.method === "session/new").length, 1);
    const restores = protocol.filter(row => row.method === "session/load");
    assert.equal(restores.length, 3);
    assert.ok(restores.every(row => row.params.sessionId === first.session_id));
    const prompts = protocol.filter(row => row.method === "session/prompt");
    assert.equal(new Set(prompts.map(row => row.pid)).size, 4);
    assert.deepEqual(prompts[1].params.prompt, [{ type: "text", text: message }]);
    assert.deepEqual(prompts[2].params.prompt, [{ type: "text", text: question }]);
    assert.deepEqual(prompts[3].params.prompt, [{ type: "text", text: continuationMessage(f.store, large) }]);
    assert.equal(fourth.interaction.messages.at(-1).status, "delivered");
    assert.equal(JSON.parse(readFileSync(path.join(f.root, "provider-history.json"), "utf8")).length, 4);
    assert.equal((await f.store.submit({ key: "pr-feedback", agent: "pr-updater", resumeId: "original",
      workspace: f.workspace, prompt: message })).turns, 4);
    if (native) {
      const historyFile = path.join(f.root, "provider-history.json");
      const lockFile = path.join(f.workspace, "repository-mcp.lock");
      writeJson(lockFile, { pid: process.pid });
      const engineeringMessage = "Deliver only when the workspace is free.", engineeringId = randomUUID();
      writeJson(path.join(f.root, "controls", "requests", `${engineeringId}.json`), {
        id: engineeringId, kind: "message", taskId: "original", message: engineeringMessage,
        createdAt: new Date().toISOString(),
      });
      await until(() => f.store.task("original")?.interaction.phase === "waiting_preparation",
        "engineering follow-up waiting for workspace admission");
      await until(() => {
        try { f.store.assertIdle("pr-updater", f.workspace, "competing-task"); }
        catch (error) { if (/reserved/.test(error.message)) return true; throw error; }
        return false;
      }, "engineering conversation reservation");
      assert.equal(JSON.parse(readFileSync(historyFile, "utf8")).length, 4);
      unlinkSync(lockFile);
      const fifth = await until(() => f.store.task("original")?.interaction.phase === "waiting_preparation"
        ? false : finished(5), "same-session engineering follow-up after the workspace releases");
      assert.equal(fifth.session_id, first.session_id);
      assert.equal(fifth.interaction.messages.at(-1).status, "delivered");
      assert.deepEqual(JSON.parse(readFileSync(historyFile, "utf8")).at(-1),
        [{ type: "text", text: engineeringMessage }]);
      f.put({ ...fifth, runner_metadata: { ...fifth.runner_metadata, runner: "pr-reviewer" } }, "completed");
      const id = randomUUID(), text = "Can you test using Storybook?";
      writeJson(path.join(f.root, "controls", "requests", `${id}.json`), {
        id, kind: "message", taskId: "original", message: text, createdAt: new Date().toISOString(),
      });
      const waiting = await until(() => {
        const task = f.store.task("original");
        return task?.interaction.phase === "waiting_preparation" && task;
      }, "reviewer follow-up waiting for dedicated preparation");
      assert.equal(waiting.status, "failed");
      assert.equal(waiting.turns, 5);
      assert.equal(waiting.provider, null);
      assert.equal(waiting.interaction.messages.at(-1).status, "queued");
      assert.equal(JSON.parse(readFileSync(historyFile, "utf8")).length, 5);
      const reviewer = createSpoolQueue(f.store, { agent: "pr-updater", workspace: f.workspace, runner: "pr-reviewer" });
      reviewer.setPreparation(f.preparation);
      await assert.rejects(reviewer.retryIssue("original", { assigneeAgentId: "pr-updater" }, waiting.updated_at),
        /Waiting for safe restart/);
      const resumed = await until(() => f.store.task("original")?.interaction.phase === "waiting_preparation"
        ? false : finished(6), "original reviewer follow-up delivery after preparation");
      assert.equal(resumed.session_id, first.session_id);
      assert.equal(resumed.interaction.messages.at(-1).status, "delivered");
      assert.deepEqual(JSON.parse(readFileSync(historyFile, "utf8")).at(-1), [{ type: "text", text }]);
    }
  } finally {
    await application?.stop();
    const active = f.store.tasks().filter(task => task.status === "in_progress" || task.provider);
    if (active.length) throw new Error(`Isolated providers left uninterrupted for inspection: ${f.root}`);
    if (daemon.exitCode === null) { const exited = once(daemon, "exit"); daemon.kill(); await exited; }
    for (const finish of cleanup) finish();
  }
});
