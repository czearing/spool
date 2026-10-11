import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createSpoolDashboard } from "../dashboard.mjs";
import { engine } from "../sources.mjs";
import { writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";
import { createMonitorHandler } from "../monitor.mjs";
import { monitorSnapshot, monitorConversation } from "../monitor-data.mjs";

const { surveyStatus } = await engine("pr-updater/lib/survey-status.mjs");

function setup(t) {
  const f = fixture(t), root = path.join(f.root, "runners");
  const names = ["pr-updater", "pr-updater-2", "pr-reviewer"];
  const runners = names.map(runner => ({ runner, healthy: true, phase: "ready", lastScan: new Date().toISOString() }));
  for (const name of names) {
    const dir = path.join(root, name, ".runner");
    mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "status.json"), { agent: name, lastScan: new Date().toISOString(), pullRequests: [] });
    writeFileSync(path.join(dir, "jobs.jsonl"), "");
    writeFileSync(path.join(dir, "activity.jsonl"), "");
  }
  const handler = createSpoolDashboard({ store: f.store, root, names, health: () => runners, metrics: () => [] });
  const request = (url, method = "GET") => new Promise((resolve, reject) => {
    let code, headers;
    Promise.resolve(handler({ url, method }, {
      writeHead(c, h) { code = c; headers = h; },
      end(body = "") { resolve({ code, headers, body }); },
    })).catch(reject);
  });
  return { ...f, root, runners, request, handler };
}

test("dashboard reuses original features and excludes reviewer diagnostics from watched PRs", async t => {
  const f = setup(t);
  writeJson(path.join(f.root, "pr-reviewer", ".runner", "status.json"), {
    lastScan: new Date().toISOString(),
    pullRequests: [{ id: "5063136", title: "Top 5 mock e2e tests", eligible: false, queueState: "ignored" }],
  });
  writeJson(path.join(f.root, "pr-updater", ".runner", "status.json"), {
    lastScan: new Date().toISOString(), agent: "pr-updater",
    pullRequests: [{ id: 7, title: "Real updater PR", unresolved: 0, ready: false,
      build: { state: "failed", label: "failing: Buddy Build" }, approvals: 1, reviewers: 2, reason: "build failure" }],
  });
  const page = await f.request("/");
  assert.equal(page.code, 200);
  for (const text of ["PR agent activity", "Real updater PR", "Buddy Build", "Approvals", "Agent / work item",
    "Activity", "/summary.json", "/jobs.json", "/ado.json", "Runner health"]) assert.ok(page.body.includes(text), text);
  assert.ok(!page.body.includes("Top 5 mock"));
  assert.ok(!page.body.includes("ready to merge"));
  assert.ok(!page.body.includes('http-equiv="refresh"'));
  assert.equal(JSON.parse((await f.request("/api/status")).body).active_prs, 1);
});

test("operator pauses are explicit in the dashboard and health API", async t => {
  const f = setup(t), marker = path.join(f.store.root, "controls", "paused", "tech-writer");
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, "Paused\n");
  assert.deepEqual(JSON.parse((await f.request("/api/status")).body).paused_agents, ["tech-writer"]);
  assert.match((await f.request("/")).body, /Paused agents: tech-writer/);
});

test("a pending interactive creator is visible without linking to a nonexistent Spool task", async t => {
  const f = setup(t);
  writeJson(path.join(f.store.records, "native-creators", "interactive-7.json"), {
    verified: true, prId: "7", originKind: "copilot_cli", creatorName: "Original interactive author",
    agent: "software-engineer", taskId: "interactive", sessionId: "original-session",
  });
  writeJson(path.join(f.root, "pr-updater", ".runner", "status.json"), {
    lastScan: new Date().toISOString(), agent: "pr-updater",
    pullRequests: [{ id: 7, title: "Waiting on original author", unresolved: 1, ready: false,
      build: { state: "passed", label: "2/2 passed" }, approvals: 0, reviewers: 1,
      reason: "Original interactive author is still active" }],
  });
  const pending = await f.request("/");
  assert.match(pending.body, /Original interactive author/);
  assert.doesNotMatch(pending.body, /job\?id=spool%3Ainteractive/);
  f.put({ id: "interactive", agent: "software-engineer" }, "failed");
  assert.match((await f.request("/")).body, /job\?id=spool%3Ainteractive/);
});
test("shared survey projection preserves readiness gates, approvals, build health and shard ownership", () => {
  const row = { pr: { id: 7, mergeStatus: "succeeded", votes: [10] },
    builds: [{ result: "succeeded" }], approval: { approvals: 1, reviewers: 2, label: "1" },
    counts: { unresolved: 0, human: [], automated: [] }, verdict: null, send: false };
  assert.equal(surveyStatus([row], { shard: { total: 2, index: 1 } })[0].ready, true);
  const held = surveyStatus([{ ...row, builds: [], holdingReason: "Awaiting CI" }], { shard: { total: 2, index: 0 } })[0];
  assert.equal(held.ready, false);
  assert.equal(held.approvals, 1);
  assert.equal(held.reviewers, 2);
  assert.equal(held.dispatchOwner, false);
  assert.equal(held.dispatchHold, "Awaiting CI");
  assert.equal(surveyStatus([{ ...row, pr: { ...row.pr, isDraft: true } }], {})[0].ready, false);
});

test("Spool history paginates and full detail exposes actual logs, sessions, cost and workspace", async t => {
  const f = setup(t);
  for (let i = 0; i < 25; i++) f.put({ id: `history-${i}`, session_id: `session-${i}`, turns: 3,
    cost: { total_cost_usd: 1.25 } }, "completed");
  mkdirSync(path.join(f.store.root, "logs"));
  const transcript = `Actual agent log ${"long transcript ".repeat(600)}END-OF-TRANSCRIPT`;
  writeFileSync(path.join(f.store.root, "logs", "history-0.log"), transcript);
  const page = await f.request("/");
  assert.match(page.body, /Older history/);
  assert.doesNotMatch(page.body, /END-OF-TRANSCRIPT/);
  const detail = await f.request("/job?id=spool%3Ahistory-0&fragment=1");
  for (const text of ["END-OF-TRANSCRIPT", "session-0", "1.25", "Turns", "Workspace"]) {
    assert.ok(detail.body.toLowerCase().includes(text.toLowerCase()), text);
  }
  assert.equal((await f.request("/history?offset=20")).code, 200);
  assert.equal((await f.request("/job?id=missing")).code, 404);
  assert.equal((await f.request("/history?offset=-1")).code, 400);
  assert.equal((await f.request("/", "POST")).code, 405);
  assert.equal((await f.request("/favicon.ico")).code, 204);
});

test("queue state overrides stale telemetry and preserves preparation timings without duplicate history", async t => {
  const f = setup(t), key = "submission-key";
  writeFileSync(path.join(f.root, "pr-updater", ".runner", "jobs.jsonl"),
    JSON.stringify({ jobId: key, state: "dispatched", prId: 7, setupMs: 4000, dispatchedAt: "2026-09-14T00:00:00Z" }) + "\n");
  f.put({ id: "dispatched", session_id: "preserved-session", status: "incoming" }, "completed");
  writeJson(path.join(f.store.records, "task-dispatched.json"), { key, prId: 7 });
  const data = JSON.parse((await f.request("/jobs.json")).body);
  assert.equal(data.jobs.length, 1);
  assert.equal(data.jobs[0].state, "done");
  assert.equal(data.jobs[0].setupMs, 4000);
  assert.equal(data.jobs[0].sessionId, "preserved-session");
  assert.match(data.jobs[0].outcome, /PR outcome unverified/);
  f.runners[0].healthy = false;
  f.runners[0].healthReason = "Preparation has not completed";
  assert.equal((await f.request("/api/status")).code, 503);
  assert.match((await f.request("/")).body, /Preparation has not completed/);
});

test("cancelled imports are historical cancellations, not current failed creator executions", async t => {
  const f = setup(t);
  f.put({ id: "cancelled-import" }, "failed");
  writeJson(path.join(f.store.records, "ownership.json"), { version: 1, pullRequests: [], tasks: [
    { taskId: "cancelled-import", sourceStatus: "cancelled" },
  ] });
  const data = JSON.parse((await f.request("/jobs.json")).body);
  assert.equal(data.summary.failed, 0);
  assert.equal(data.summary.done, 0);
  assert.equal(data.jobs[0].sourceStatus, "cancelled");
  assert.equal(data.jobs[0].historical, true);
  assert.match(data.jobs[0].outcome, /imported cancelled/);
  const page = await f.request("/");
  assert.match(page.body, /current creator revisions/);
  assert.match(page.body, /1 cancelled/);
  assert.match(page.body, /prior preparation\/execution failures remain/);
});

test("a completed creator execution remains unverified until matching independent evidence exists", async t => {
  const f = setup(t);
  f.put({ id: "creator" }, "completed");
  writeJson(path.join(f.store.records, "ownership.json"), { version: 1, pullRequests: [], tasks: [] });
  writeJson(path.join(f.store.records, "task-creator.json"), { key: "current-revision", prId: "123", contract: {} });
  const load = async () => JSON.parse((await f.request("/jobs.json")).body);
  assert.equal((await load()).summary.done, 0);
  assert.equal((await load()).jobs[0].outcome, "awaiting PR verification");
  assert.equal((await load()).jobs[0].state, "verifying");
  const file = path.join(f.store.records, "verification-creator.json");
  writeJson(file, { submissionId: "old-revision", ok: true });
  assert.equal((await load()).summary.done, 0);
  writeJson(file, { submissionId: "current-revision", ok: true });
  assert.equal((await load()).summary.done, 1);
  writeJson(file, { submissionId: "current-revision", ok: false, reason: "Pushed head does not match" });
  assert.equal((await load()).summary.failed, 1);
});

test("blocked preparation is visible as a hold, not in-flight work or an agent timer", async t => {
  const f = setup(t), runtime = path.join(f.root, "pr-updater", ".runner");
  writeJson(path.join(runtime, "status.json"), { lastScan: new Date().toISOString(),
    pullRequests: [{ id: "7", title: "Held PR", dispatchOwner: true, actionable: true,
      dispatchHold: "Resume branch does not match; checkout preserved", ready: false }] });
  writeFileSync(path.join(runtime, "jobs.jsonl"), JSON.stringify({
    jobId: "held", prId: "7", state: "blocked", at: "2026-09-18T00:00:00Z",
  }) + "\n");
  const page = (await f.request("/")).body;
  assert.doesNotMatch(page, /agent working/);
  assert.match(page, /Resume branch does not match/);
  assert.match(page, /No active or queued work/);
});

test("minimal agent page lists idle, paused, live and queued work without confusing queue state with liveness", async t => {
  const f = setup(t);
  f.put({ id: "running", agent: "perf", session_id: "live-session" }, "in_progress");
  f.put({ id: "stale", agent: "software-engineer", session_id: "dead-session" }, "in_progress");
  f.put({ id: "queued", agent: "pr-updater" });
  let processReads = 0;
  f.store.processes = () => { processReads++; return [{ Name: "copilot.exe", CommandLine: "--session-id live-session" }]; };
  mkdirSync(path.join(f.store.root, "controls", "paused"), { recursive: true });
  writeFileSync(path.join(f.store.root, "controls", "paused", "tech-writer"), "Paused");
  const page = await f.request("/agents");
  assert.equal(page.code, 200);
  assert.match(page.body, /Spool Monitor/);
  assert.match(page.headers["content-security-policy"], /connect-src 'self'/);
  const { agents } = JSON.parse((await f.request("/api/agents")).body);
  assert.equal(agents.find(a => a.name === "perf").state, "Running");
  assert.equal(agents.find(a => a.name === "software-engineer").state, "No process observed");
  assert.equal(agents.find(a => a.name === "pr-updater").state, "Queued");
  assert.equal(agents.find(a => a.name === "pr-reviewer").state, "Idle");
  assert.equal(agents.find(a => a.name === "tech-writer").state, "Paused");
  assert.equal(agents.find(a => a.name === "perf").currentTaskId, "running");
  await f.request("/api/agents");
  assert.equal(processReads, 1, "Concurrent clients reuse a short-lived process snapshot");
});

test("agent conversations show actual messages and tool output, notes, and new appended output", async t => {
  const f = setup(t), attack = "<script>window.injected=true</script>";
  f.put({ id: "conversation", comments: [{ author: "agent", message: "Saved update" }] }, "completed");
  mkdirSync(path.join(f.store.root, "logs"));
  const file = path.join(f.store.root, "logs", "conversation.log");
  const rows = [
    { type: "user.message", data: { content: "Original instructions" } },
    { type: "assistant.message", data: { content: attack } },
    { type: "tool.execution_start", data: { toolName: "powershell", arguments: { command: "read-only command" } } },
    { type: "tool.execution_complete", data: { success: true, result: { content: "Exit code: 1" } } },
    { type: "assistant.reasoning", data: { content: "Not conversation output" } },
  ];
  writeFileSync(file, rows.map(JSON.stringify).join("\n") + "\n");
  const log = JSON.parse((await f.request("/api/agent-log?task=conversation")).body);
  assert.equal(log.available, true);
  assert.equal(log.messages.length, 5);
  assert.equal(log.messages[1].text, attack);
  assert.equal(log.messages[3].title, "Tool result");
  assert.equal(log.messages[3].text, "Exit code: 1");
  assert.equal(log.messages[4].text, "Saved update");
  assert.doesNotMatch((await f.request("/agents")).body, /window.injected/);
  rows.push({ type: "assistant.message", data: { content: "New live output" } });
  writeFileSync(file, rows.map(JSON.stringify).join("\n") + "\n");
  assert.ok(JSON.parse((await f.request("/api/agent-log?task=conversation")).body).messages.some(m => m.text === "New live output"));
});

test("agent log reads are bounded, missing logs are explicit, and routes cannot traverse or mutate files", async t => {
  const f = setup(t);
  f.put({ id: "large" }, "failed");
  const missing = JSON.parse((await f.request("/api/agent-log?task=large")).body);
  assert.equal(missing.available, false);
  mkdirSync(path.join(f.store.root, "logs"));
  writeFileSync(path.join(f.store.root, "logs", "large.log"), "x".repeat(600000) + "\n" +
    JSON.stringify({ type: "assistant.message", data: { content: "Latest evidence" } }) + "\n{\"type\":");
  const log = JSON.parse((await f.request("/api/agent-log?task=large")).body);
  assert.equal(log.limited, true);
  assert.deepEqual(log.messages.map(m => m.text), ["Latest evidence"]);
  assert.ok(log.nextBefore > 0);
  let position = log.nextBefore, older;
  for (let page = 0; page < 4 && position !== null; page++) {
    older = JSON.parse((await f.request(`/api/agent-log?task=large&before=${position}`)).body);
    assert.ok(older.nextBefore === null || older.nextBefore < position);
    position = older.nextBefore;
  }
  assert.equal(older.nextBefore, null);
  assert.ok(older.messages.some(m => m.text.startsWith("xxx")));
  assert.equal((await f.request("/api/agent-log?task=large&before=-1")).code, 400);
  assert.equal((await f.request("/api/agent-log?task=missing")).code, 404);
  assert.equal((await f.request("/api/agent-log?task=..%2F..%2Fsecret")).code, 400);
  assert.equal((await f.request("/api/agents", "POST")).code, 405);
  assert.equal((await f.request("/agents", "HEAD")).body, "");
  f.store.processes = () => { throw Error("Process lookup failed"); };
  f.put({ id: "process-error", session_id: "session" });
  assert.equal((await f.request("/api/agents")).code, 500);
});

test("Paperclip monitoring supports navigation, history, live output, failures and recovery", {
  skip: !process.env.DASHBOARD_PLAYWRIGHT_MODULE || !process.env.DASHBOARD_BROWSER_EXECUTABLE,
  timeout: 60000,
}, async t => {
  const { createServer } = await import("node:http");
  const { pathToFileURL } = await import("node:url");
  const { chromium } = await import(pathToFileURL(process.env.DASHBOARD_PLAYWRIGHT_MODULE).href);
  const f = setup(t);
  f.put({ id: "old-review", agent: "pr-reviewer", title: "Old review" }, "completed");
  f.put({ id: "new-review", agent: "pr-reviewer", title: "Latest review", updated_at: "2026-09-22T18:00:00Z" }, "completed");
  f.put({ id: "perf-current", agent: "perf", title: "Current perf investigation", session_id: "browser-live" }, "in_progress");
  f.put({ id: "long-perf-history", agent: "perf", title: "Long historical PR title ".repeat(12) }, "failed");
  f.put({ id: "failed-engineer", agent: "software-engineer", title: "Publication blocked", error: "Publisher could not reconcile PR creation" }, "failed");
  f.store.processes = () => [{ Name: "copilot.exe", CommandLine: "--session-id browser-live" }];
  mkdirSync(path.join(f.store.root, "logs"));
  const writeLog = message => writeFileSync(path.join(f.store.root, "logs", "perf-current.log"),
    JSON.stringify({ type: "assistant.message", data: { content: message } }) + "\n");
  writeLog("<script>window.injected=true</script> initial output");
  let unavailable = false, browser, indexReads = 0;
  const monitor = createMonitorHandler({
    snapshot: () => monitorSnapshot(f.store, f.store.processes()),
    conversation: (id, before) => monitorConversation(f.store, id, before),
  });
  const server = createServer((request, response) => {
    if (request.url === "/api/monitor/snapshot") indexReads++;
    if (unavailable && request.url === "/api/monitor/snapshot") { response.writeHead(503); response.end("fixture unavailable"); }
    else monitor(request, response).then(handled => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.DASHBOARD_BROWSER_EXECUTABLE, headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const external = [], errors = [];
  await context.route("**/*", route => {
    if (route.request().url().startsWith(origin + "/")) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin + "/agents/pr-reviewer");
  await page.getByRole("heading", { name: "pr-reviewer", exact: true }).waitFor();
  const initialIndexReads = indexReads;
  await page.getByRole("link", { name: /Old review/ }).click();
  await page.getByRole("heading", { name: "Old review", exact: true }).waitFor();
  assert.match(await page.locator("main").textContent(), /Recorded task/);
  await page.locator('aside a[href="/agents"]').click();
  await page.getByRole("link", { name: /^perf Current:/ }).click();
  await page.getByRole("link", { name: "Open current conversation" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="conversation"]')?.textContent.includes("initial output"));
  assert.equal(indexReads, initialIndexReads, "Selecting tasks or agents must not repeat the fleet process scan");
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await page.getByRole("link", { name: /Publication blocked/ }).click();
  await page.getByRole("alert").filter({ hasText: "Recorded task failure: Publisher" }).waitFor();
  assert.match(await page.locator("main").textContent(), /Recorded task.*failed/);
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await page.getByRole("link", { name: /Current perf investigation/ }).click();
  writeLog("New live output");
  await page.waitForFunction(() => document.querySelector('[data-testid="conversation"]')?.textContent.includes("New live output"), null, { timeout: 15000 });
  const event = content => JSON.stringify({ type: "assistant.message", data: { content } }) + "\n";
  const tool = JSON.stringify({ type: "tool.execution_complete", data: { result: { content: "x".repeat(12000) } } }) + "\n";
  writeFileSync(path.join(f.store.root, "logs", "perf-current.log"), event("Earlier output") + tool.repeat(50) + event("New live output"));
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Older output" && !button.disabled), null, { timeout: 15000 });
  for (let i = 0; i < 4 && !(await page.locator('[data-testid="conversation"]').textContent()).includes("Earlier output"); i++) {
    const previousUrl = await page.evaluate(() => performance.getEntriesByType("resource").filter(r => r.name.includes("/api/monitor/task")).at(-1)?.name);
    await page.getByRole("button", { name: "Older output", exact: true }).click();
    await page.waitForResponse(response => response.url().includes("/api/monitor/task") && response.url() !== previousUrl);
  }
  await page.waitForFunction(() => document.querySelector('[data-testid="conversation"]')?.textContent.includes("Earlier output"));
  await page.getByRole("button", { name: "Latest", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="conversation"]')?.textContent.includes("New live output"));
  unavailable = true;
  await page.getByRole("alert").filter({ hasText: "fixture unavailable" }).waitFor({ timeout: 15000 });
  assert.match(await page.getByRole("alert").textContent(), /stale/);
  unavailable = false;
  await page.getByRole("alert").waitFor({ state: "detached", timeout: 15000 });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
