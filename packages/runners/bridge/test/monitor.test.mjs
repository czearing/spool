import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { monitorSnapshot, monitorConversation, logWindow } from "../monitor-data.mjs";
import { createMonitorHandler } from "../monitor.mjs";

test("monitor projects actual liveness separately from queue and historical failures", t => {
  const f = fixture(t);
  f.put({ id: "live", agent: "perf", session_id: "live-session" }, "in_progress");
  f.put({ id: "stale", agent: "software-engineer", session_id: "missing" }, "in_progress");
  f.put({ id: "past", agent: "pr-reviewer", error: "Past review failed" }, "failed");
  mkdirSync(path.join(f.root, "controls", "paused"), { recursive: true });
  writeFileSync(path.join(f.root, "controls", "paused", "tech-writer"), "operator pause");
  const data = monitorSnapshot(f.store, [{ Name: "copilot.exe", CommandLine: "--session-id live-session" }]);
  assert.equal(data.agents.find(a => a.name === "perf").state, "Running");
  assert.equal(data.agents.find(a => a.name === "software-engineer").state, "No process observed");
  assert.equal(data.agents.find(a => a.name === "pr-reviewer").state, "Idle");
  assert.equal(data.agents.find(a => a.name === "tech-writer").state, "Paused");
  assert.equal(data.tasks.find(t => t.id === "past").error, "Past review failed");
});

test("conversation preserves native entry shapes and paging without reasoning", t => {
  const f = fixture(t);
  f.put({ id: "review", comments: [{ author: "agent", message: "Saved result" }] }, "completed");
  mkdirSync(path.join(f.root, "logs"));
  const event = (type, data) => JSON.stringify({ type, timestamp: "2026-09-22T22:00:00Z", data }) + "\n";
  const content = event("assistant.message", { content: "Earlier message" }) +
    event("tool.execution_start", { toolName: "powershell", toolCallId: "call", arguments: { command: "inspect" } }) +
    event("tool.execution_complete", { toolCallId: "call", success: false, result: { content: "Failed check" } }) +
    event("assistant.reasoning", { content: "private-reasoning-not-for-display" }) +
    event("assistant.message", { content: "x".repeat(12000) }).repeat(30) +
    event("assistant.message", { content: "Latest message" }) + '{"type":';
  assert.ok(Buffer.byteLength(content) > logWindow);
  writeFileSync(path.join(f.root, "logs", "review.log"), content);
  const latest = monitorConversation(f.store, "review");
  assert.ok(latest.entries.some(entry => entry.text === "Latest message"));
  assert.equal(latest.notes[0].text, "Saved result");
  assert.equal(latest.limited, true);
  const earlier = monitorConversation(f.store, "review", latest.nextBefore);
  assert.ok(earlier.entries.some(entry => entry.text === "Earlier message"));
  assert.equal(earlier.entries.find(entry => entry.kind === "tool_call").toolUseId, "call");
  assert.equal(earlier.entries.find(entry => entry.kind === "tool_result").isError, true);
  assert.doesNotMatch(JSON.stringify([latest, earlier]), /private-reasoning/);
  assert.throws(() => monitorConversation(f.store, "review", -1), /Invalid/);
  assert.equal(monitorConversation(f.store, "absent"), null);
});

test("monitor serves production pages and assets, rejects writes and traversal, surfaces errors", async t => {
  const f = fixture(t);
  f.put({ id: "one" }, "completed");
  const handler = createMonitorHandler({
    snapshot: () => monitorSnapshot(f.store, []),
    conversation: (id, before) => monitorConversation(f.store, id, before),
  });
  const request = (url, method = "GET") => new Promise((resolve, reject) => {
    let code, headers;
    handler({ url, method }, {
      writeHead(c, h) { code = c; headers = h; },
      end(body) { resolve({ code, headers, body }); },
    }).then(handled => { if (!handled) resolve({ code: 404 }); }).catch(reject);
  });
  const page = await request("/");
  assert.equal(page.code, 200);
  assert.match(page.body, /Spool/);
  assert.doesNotMatch(page.body, /Agent conversations|PR agent activity/);
  assert.match(page.headers["content-security-policy"], /connect-src 'self'/);
  const script = /src="([^"]+\.js)"/.exec(page.body)[1];
  assert.equal((await request(script)).code, 200);
  assert.match((await request(script)).headers["cache-control"], /immutable/);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await request("/api/monitor/task?id=one", method)).code, 405);
  }
  assert.equal((await request("/agents", "HEAD")).body, "");
  assert.equal((await request("/projects/spool")).code, 200);
  assert.equal((await request("/projects/spool/agents/pr-reviewer")).code, 200);
  assert.equal((await request("/api/monitor/task?id=..%2Fsecret")).code, 400);
  assert.equal((await request("/api/monitor/task?id=one&before=Infinity")).code, 400);
  assert.equal((await request("/api/monitor/task?id=absent")).code, 404);
  assert.equal((await request("/assets/%2e%2e%5csecret.js")).code, 404);
  assert.equal((await request("/api/monitor/unknown")).code, 404);
  assert.equal((await request("/job?id=spool%3Aone")).headers.location, "/tasks/one");
  for (const [source, target] of [
    ["/SPOOL", "/"],
    ["/SPOOL/dashboard", "/"],
    ["/SPOOL/agents/all", "/agents"],
    ["/SPOOL/issues/all", "/tasks"],
  ]) {
    for (const suffix of ["", "/", "?view=board"]) {
      for (const method of ["GET", "HEAD"]) {
        const redirect = await request(source + suffix, method);
        assert.equal(redirect.code, 302);
        assert.equal(redirect.headers.location, target);
        assert.equal(redirect.headers["cache-control"], "no-store");
        assert.equal(redirect.body, "");
      }
    }
    assert.equal((await request(source, "POST")).code, 405);
  }
  assert.equal((await request("/SPOOL/unsupported")).code, 404);
});

test("copied Harness components match the original working-tree source-byte pins", () => {
  const root = path.resolve(import.meta.dirname, "..", "..", "monitor", "vendor", "harness");
  const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
  for (const name of ["ProjectView", "ProjectSidebar", "ChatPanel", "TaskEditor", "ChatVirtualHistory"])
    assert.ok(Object.keys(manifest.files).some(file => file.endsWith(`${name}.tsx`)));
  for (const [file, sha256] of Object.entries(manifest.files)) {
    assert.equal(createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex"), sha256, file);
  }
});

test("production renderer starts monitoring automatically and survives a renderer restart without agents", {
  timeout: 30000,
}, async t => {
  const f = fixture(t);
  f.put({ id: "startup-test", title: "Automatic monitoring" }, "completed");
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "..", "dashboard-rpc.mjs")], {
      env: { ...process.env, SPOOL_RUNNER_CONFIG: JSON.stringify({ spool_dir: f.root, dashboard_port: 8261 }) },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    const cleanup = () => { lines.close(); if (child.exitCode === null) child.kill(); };
    t.after(cleanup);
    assert.equal(JSON.parse((await iterator.next()).value).ready, true, stderr);
    const request = async url => {
      child.stdin.write(JSON.stringify({ method: "GET", url }) + "\n");
      return JSON.parse((await iterator.next()).value);
    };
    assert.match((await request("/")).body, /Spool/);
    let snapshot, lastSnapshot;
    for (let i = 0; i < 40; i++) {
      const result = await request("/api/monitor/snapshot");
      lastSnapshot = result;
      if (result.code === 200) { snapshot = JSON.parse(result.body); break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(snapshot, `${stderr}\n${lastSnapshot?.body}`);
    assert.equal(snapshot.tasks[0].title, "Automatic monitoring");
    const elapsed = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const result = await request(i % 2 ? "/api/monitor/snapshot" : "/api/monitor/task?id=startup-test");
      elapsed.push(performance.now() - start);
      assert.equal(result.code, 200);
    }
    assert.ok(Math.max(...elapsed) < 250, `Cached request latencies: ${elapsed.join(", ")}`);
    child.stdin.end();
    await new Promise(resolve => child.once("exit", resolve));
    lines.close();
  }
});
