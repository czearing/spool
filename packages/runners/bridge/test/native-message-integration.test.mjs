import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { readJson } from "../spool-store.mjs";
import { createMonitorControls } from "../monitor-controls.mjs";
import { continuationMessage } from "../message-payload.mjs";

test("runner and chat messages restore one native conversation and send only their new input", { timeout: 90000 }, async t => {
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
  const env = { ...process.env, SPOOL_TEST_BINARY: binary, SPOOL_INTERACTIVE_ACP: "1",
    SPOOL_NATIVE_MESSAGE_FIXTURE: f.root };
  const realPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1];
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = bin + path.delimiter + realPath;
  const daemon = spawn(binary, ["--root", f.root, "daemon"], {
    cwd: f.root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  for (const stream of [daemon.stdout, daemon.stderr]) stream.on("data", bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
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
    if (task?.status === "failed") throw new Error(task.error);
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
    git("checkout", "-q", "-b", "chat-branch");
    const controls = createMonitorControls(f.store), id = randomUUID(), question = "What did you change?";
    controls.submit({ id, kind: "message", taskId: "original", message: question });
    const third = await until(() => finished(3), "chat provider completion");
    assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "chat-branch");
    assert.equal(Object.hasOwn(third.session_config, "branch"), false);
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
  } finally {
    const active = f.store.tasks().filter(task => task.status === "in_progress" || task.provider);
    if (active.length) throw new Error(`Isolated providers left uninterrupted for inspection: ${f.root}`);
    if (daemon.exitCode === null) { const exited = once(daemon, "exit"); daemon.kill(); await exited; }
    for (const finish of cleanup) finish();
  }
});
