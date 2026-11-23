import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { once } from "node:events";

for (const obsolete of [false, true]) test(`packaged conversation repairs legacy delivery without resend ${obsolete ? "despite obsolete overrides" : "with production configuration"}`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "spool-legacy-receipt-"));
  const project = path.join(root, "project"), history = path.join(root, "history"), session = randomUUID();
  for (const folder of ["agents", "logs", "controls", ...["incoming", "in_progress", "completed", "failed"].map(queue => path.join("queues", queue))])
    await mkdir(path.join(project, folder), { recursive: true });
  await mkdir(path.join(history, session), { recursive: true });
  await writeFile(path.join(root, "projects.json"), JSON.stringify({
    version: 1, projects: [{ id: "fixture", name: "Fixture", root: project }],
  }));
  await writeFile(path.join(project, "agents", "engineer.md"), "# Isolated fixture; do not launch a provider.");
  const task = { id: "original", title: "Original", agent: "engineer", prompt: "Do not replay",
    status: "in_progress", session_id: session, created_at: "2026-11-19T01:00:00Z", updated_at: "2026-11-19T01:00:00Z",
    interaction: { phase: "running", messages: [{ id: "message", text: "Make the priority table",
      status: "delivery_uncertain", session_id: session, created_at: "2026-11-19T01:07:17Z" }] } };
  const file = path.join(project, "queues", "in_progress", "original.json");
  await writeFile(file, JSON.stringify(task));
  await writeFile(path.join(project, "logs", "original.log"), [
    { type: "session.start", timestamp: "2026-11-19T01:07:18Z", data: { sessionId: session, taskId: task.id } },
    { type: "user.message", timestamp: "2026-11-19T01:07:18Z", data: { messageId: "message", content: "Make the priority table" } },
    { type: "session.turn_end", timestamp: "2026-11-19T01:07:29Z", data: { sessionId: session, stopReason: "cancelled" } },
  ].map(event => JSON.stringify(event) + "\n").join(""));
  await writeFile(path.join(history, session, "events.jsonl"), JSON.stringify({
    type: "user.message", timestamp: "2026-11-19T01:07:24Z",
    data: { content: "Autopilot objective: Make the priority table", agentMode: "autopilot" },
  }) + "\n");
  const backend = process.env.SPOOL_TEST_BACKEND || path.resolve(import.meta.dirname, "../src-tauri/resources/backend.mjs");
  const child = spawn(process.execPath, [backend], {
    cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SPOOL_DESKTOP_TASK_RUNTIME: obsolete ? "1" : undefined, SPOOL_COPILOT_SESSION_ROOT: history,
      SPOOL_AGENT_BINARY: obsolete ? path.join(root, "must-not-run") : undefined },
  });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) await once(child, "exit");
    await rm(root, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout }), frames = [];
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Backend exited ${code}: ${stderr}`)));
    lines.on("line", line => {
      const frame = JSON.parse(line);
      if (frame.id === "ready") resolve();
      else frames.push(frame);
    });
  });
  await writeFile(path.join(project, "controls", "capabilities.json"), JSON.stringify({
    version: 1, interactive: true, taskControl: true, pid: process.pid, updatedAt: new Date().toISOString(),
  }));
  const response = new Promise((resolve, reject) => lines.on("line", line => {
    const frame = JSON.parse(line);
    if (frame.type === "error") reject(new Error(`${frame.error}: ${stderr}`));
    if (frame.type === "end") resolve();
  }));
  child.stdin.write(JSON.stringify({
    id: "conversation", method: "GET", headers: [], url: "/api/projects/fixture/tasks/original/conversation?events=1",
  }) + "\n");
  await response;
  assert.equal(frames[0].status, 200, stderr);
  const body = JSON.parse(frames.filter(frame => frame.type === "chunk")
    .map(frame => Buffer.from(frame.body, "base64").toString()).join(""));
  assert.equal(body.recoveryAvailable, false, "The fixture must represent a legacy daemon without recovery support.");
  assert.equal(body.task.interaction.messages[0].status, "delivered");
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.session_id, session);
  assert.equal(saved.interaction.phase, "running");
  assert.equal(saved.interaction.messages.length, 1);
  assert.equal(saved.interaction.messages[0].status, "delivered");
  assert.deepEqual(await readdir(path.join(project, "queues", "incoming")), []);
  const requests = path.join(project, "controls", "requests");
  assert.deepEqual(await readdir(requests).catch(error => { if (error.code === "ENOENT") return []; throw error; }), []);
});
