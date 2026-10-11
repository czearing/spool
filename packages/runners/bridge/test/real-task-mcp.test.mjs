import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fixture } from "./fixtures.mjs";

test("real ACP provider exposes task tools on both new and restored sessions", {
  skip: !process.env.SPOOL_REAL_MCP_BINARY,
  timeout: 600000,
}, async t => {
  let cleanup;
  const f = fixture({ after: callback => { cleanup = callback; } });
  const binary = process.env.SPOOL_REAL_MCP_BINARY;
  const id = "real-mcp-task", agent = "mcp-check";
  const role = "You are an isolated integration verifier. Only use tool discovery and the task-scoped Spool MCP tools. Do not run shell commands, read or edit files, create other tasks, call external APIs, or change repositories.";
  writeFileSync(path.join(f.root, "agents", `${agent}.md`), `---\nmodel: gpt-6-astra\n---\n${role}`);
  const markers = [randomUUID(), randomUUID()].map(value => `MCP-VERIFIED-${value}`);
  const prompt = marker => `Read the current work item using spool_get_task. It must be ${id}. Add a comment containing exactly ${marker} using spool_add_comment, then use spool_update_task_status to mark this task completed. Read it back with spool_get_task to verify the saved comment and completed status. A final text response alone is not completion. If Spool tools are unavailable, report that failure instead of claiming success.`;
  f.put({ id, agent, prompt: prompt(markers[0]) });
  mkdirSync(path.join(f.root, ".runner-receipts"));
  writeFileSync(path.join(f.root, ".runner-receipts", `task-${id}.json`), "{}");
  const daemon = spawn(binary, ["--root", f.root, "daemon"], {
    env: { ...process.env, SPOOL_INTERACTIVE_ACP: "1" }, windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const closed = once(daemon, "close");
  let diagnostics = "", settled = false;
  daemon.stderr.on("data", bytes => { diagnostics += bytes; });
  async function completed(turns) {
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      assert.equal(daemon.exitCode, null, diagnostics);
      const task = f.store.task(id);
      if (task && ["failed", "completed"].includes(task.status) && !task.provider && task.turns >= turns) {
        settled = true;
        assert.equal(task.status, "completed", JSON.stringify(task));
        return task;
      }
      await delay(250);
    }
    throw new Error(`Provider still active; preserved fixture daemon ${daemon.pid}, root ${f.root}`);
  }
  try {
    const first = await completed(1);
    assert.ok(first.comments.some(comment => comment.message === markers[0]));
    const eventFile = path.join(homedir(), ".copilot", "session-state", first.session_id, "events.jsonl");
    const events = () => readFileSync(eventFile, "utf8").trim().split("\n").map(JSON.parse);
    const firstEvents = events();
    const firstFile = path.join(f.root, "queues", "completed", `${id}.json`);
    writeFileSync(firstFile, JSON.stringify({ ...first, status: "incoming", prompt: prompt(markers[1]) }));
    settled = false;
    renameSync(firstFile, path.join(f.root, "queues", "incoming", `${id}.json`));
    const second = await completed(2);
    assert.equal(second.session_id, first.session_id);
    assert.ok(second.comments.some(comment => comment.message === markers[0]));
    assert.ok(second.comments.some(comment => comment.message === markers[1]));
    const all = events();
    assert.deepEqual(all.slice(0, firstEvents.length), firstEvents);
    const users = all.filter(event => event.type === "user.message");
    assert.equal(users.length, 2);
    assert.equal(users[0].data.content, `${role}\n\n${prompt(markers[0])}`);
    assert.equal(users[1].data.content, `${role}\n\n${prompt(markers[1])}`);
    for (const round of [firstEvents, all.slice(firstEvents.length)]) {
      const calls = round.filter(event => event.type === "tool.execution_start").map(event => event.data.toolName);
      for (const tool of ["spool_get_task", "spool_add_comment", "spool_update_task_status"]) {
        assert.ok(calls.some(name => name.endsWith(tool)), `Real provider did not call ${tool}`);
      }
      assert.ok(calls.every(name => name === "tool_search_tool" || name.startsWith("spool")), JSON.stringify(calls));
    }
    const proof = { at: new Date().toISOString(), binary,
      sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
      sessionId: second.session_id, taskId: id, realProvider: true, freshAndResumedToolsVerified: true,
      explicitCompletion: true, comments: second.comments, originalSessionEventsPreserved: true,
      noHistoryAppended: true };
    if (process.env.SPOOL_REAL_MCP_PROOF) writeFileSync(process.env.SPOOL_REAL_MCP_PROOF, JSON.stringify(proof, null, 2));
    console.log(JSON.stringify(proof));
  } catch (error) {
    console.error(diagnostics);
    const log = path.join(f.root, "logs", `${id}.log`);
    if (existsSync(log)) console.error(readFileSync(log, "utf8").slice(-12000));
    throw error;
  } finally {
    if (settled) {
      daemon.kill();
      await closed;
      cleanup();
    } else console.error(`Active provider preserved: daemon ${daemon.pid}, fixture ${f.root}`);
  }
});
