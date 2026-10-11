import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./fixtures.mjs";

test("one-shot creation is preserved but runner conversation followups require native ACP", {
  skip: !process.env.SPOOL_TASK_SPOOL_BINARY, timeout: 60000,
}, async t => {
  let cleanup;
  const f = fixture({ after: fn => { cleanup = fn; } }, { nativeMessages: false });
  const bin = path.join(f.root, "bin");
  const loader = path.join(bin, "node_modules", "@github", "copilot", "npm-loader.js");
  mkdirSync(path.dirname(loader), { recursive: true });
  copyFileSync(path.join(import.meta.dirname, "fixtures", "task-workflow-provider.cjs"), loader);
  writeFileSync(path.join(f.root, "fixture-only"), "Isolated provider fixture");
  const providerFile = path.join(f.root, "provider-software-engineer.json");
  const release = path.join(f.root, "release-software-engineer");
  const daemon = spawn(process.env.SPOOL_TASK_SPOOL_BINARY, ["--root", f.root, "daemon"], {
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      SPOOL_TASK_FIXTURE: f.root, SPOOL_INTERACTIVE_ACP: "0" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(daemon, "exit");
  let diagnostics = "";
  for (const stream of [daemon.stdout, daemon.stderr]) stream.on("data", data => { diagnostics += data; });
  const until = async check => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (check()) return;
      await delay(50);
    }
    throw new Error(`Provider lifecycle timed out: ${diagnostics}`);
  };
  try {
    const input = { key: "original", agent: "software-engineer", workspace: f.workspace,
      title: "Original work", prompt: "Unique original brief" };
    const original = await f.store.submit(input);
    await until(() => existsSync(providerFile));
    const first = JSON.parse(readFileSync(providerFile, "utf8"));
    assert.ok(first.args.includes("--session-id"));
    assert.match(first.input, /Fixture agent\. Never executed/);
    writeFileSync(release, "finish original turn");
    await until(() => f.store.task(original.id)?.status === "completed" && f.store.task(original.id)?.turns === 1);
    unlinkSync(release);
    unlinkSync(providerFile);
    await assert.rejects(f.store.submit({ ...input, key: "follow-up", resumeId: original.id,
      prompt: "Only new feedback" }), /not online/);
    assert.equal(f.store.task(original.id).status, "completed");
    assert.equal(f.store.task(original.id).session_id, first.session);
    assert.equal(f.store.task(original.id).prompt, input.prompt);
    assert.equal(existsSync(providerFile), false);
  } finally {
    writeFileSync(release, "drain isolated fixture");
    await until(() => f.store.tasks().every(task => ["completed", "failed"].includes(task.status)));
    if (daemon.exitCode === null) daemon.kill();
    await closed;
    cleanup();
  }
});
