import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./fixtures.mjs";

async function until(check, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
test("Tasks UI creates work, safely assigns an active item, and preserves its original session without chat mode", {
  skip: !process.env.SPOOL_TASK_SPOOL_BINARY || !process.env.SPOOL_TASK_HTTP_BINARY || !process.env.SPOOL_MONITOR_DIST,
  timeout: 180000,
}, async t => {
  let cleanup;
  const f = fixture({ after: fn => { cleanup = fn; } });
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`, bin = path.join(f.root, "bin");
  const loader = path.join(bin, "node_modules", "@github", "copilot", "npm-loader.js");
  mkdirSync(path.dirname(loader), { recursive: true });
  copyFileSync(path.join(import.meta.dirname, "fixtures", "task-workflow-provider.cjs"), loader);
  writeFileSync(path.join(f.root, "fixture-only"), "Never operate on production tasks");
  mkdirSync(path.join(f.root, "controls", "paused"), { recursive: true });
  writeFileSync(path.join(f.root, "controls", "paused", "tech-writer"), "Preserve pause");
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    SPOOL_TASK_FIXTURE: f.root, SPOOL_INTERACTIVE_ACP: "0",
    SPOOL_HTTP_TEST_ROOT: f.root, SPOOL_HTTP_TEST_PORT: String(port) };
  const daemon = spawn(process.env.SPOOL_TASK_SPOOL_BINARY, ["--root", f.root, "daemon"],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const http = spawn(process.env.SPOOL_TASK_HTTP_BINARY,
    ["dashboard::server::tests::isolated_interactive_http_fixture", "--ignored", "--exact", "--nocapture"],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const daemonClosed = once(daemon, "exit"), httpClosed = once(http, "exit");
  let diagnostics = "", browser;
  for (const child of [daemon, http]) for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", bytes => { diagnostics += bytes; });
  }
  try {
    await until(async () => {
      try { return (await fetch(origin + "/api/monitor/control-options")).ok; }
      catch (error) { if (error.cause?.code !== "ECONNREFUSED") throw error; return false; }
    }, "native HTTP listener");
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) errors.push(message.text());
    });
    await page.goto(origin + "/tasks");
    await page.getByRole("heading", { name: "All work", exact: true }).waitFor();
    assert.doesNotMatch(await page.locator("body").innerText(), /paperclip/i);
    const options = await (await fetch(origin + "/api/monitor/control-options")).json();
    assert.equal(options.enabled, false);
    assert.equal(options.taskEnabled, true);
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const creation = page.getByRole("dialog", { name: "New task", exact: true });
    await creation.getByPlaceholder("Task title").fill("UI assignment verification");
    await creation.getByRole("combobox", { name: "Assignee", exact: true }).selectOption("pr-updater");
    await creation.getByRole("combobox", { name: "Workspace", exact: true }).selectOption("isolated");
    const instructions = "Complete the isolated work item without changing the instructions.";
    const editor = creation.locator('[contenteditable="true"]');
    await editor.fill(instructions);
    assert.equal(await creation.getByRole("button", { name: "Upload", exact: true }).count(), 0);
    await delay(1000);
    await page.reload();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    assert.equal(await creation.getByPlaceholder("Task title").inputValue(), "UI assignment verification");
    await until(async () => (await editor.innerText()) === instructions, "restored original editor draft");
    const createRequests = [];
    page.on("request", request => {
      if (request.url().endsWith("/api/monitor/control") && request.method() === "POST") createRequests.push(request.postDataJSON());
    });
    await page.route("**/api/monitor/control", route => route.fulfill({ status: 503, body: "Controlled preparation failure" }));
    await creation.getByRole("button", { name: "Start work", exact: true }).click();
    await creation.getByRole("button", { name: "Retry", exact: true }).waitFor();
    assert.match(await creation.getByRole("button", { name: "Retry", exact: true }).getAttribute("title"), /Controlled preparation failure/);
    assert.equal(await editor.innerText(), instructions);
    await page.unroute("**/api/monitor/control");
    await creation.getByRole("button", { name: "Retry", exact: true }).click();
    await creation.waitFor({ state: "hidden" });
    assert.equal(createRequests.length, 2);
    assert.equal(createRequests[0].id, createRequests[1].id, "Retry preserves the durable command identity");
    const id = `manual-${createRequests[1].id}`;
    const provider = agent => JSON.parse(readFileSync(path.join(f.root, `provider-${agent}.json`), "utf8"));
    await until(() => existsSync(path.join(f.root, "provider-pr-updater.json")), "first agent launch");
    const original = f.store.task(id), first = provider("pr-updater");
    assert.ok(original.session_id);
    assert.ok(first.input.includes(instructions));
    await page.getByRole("heading", { name: "UI assignment verification", exact: true }).waitFor();
    assert.equal(await page.getByTestId("task-assignee").getByRole("option", { name: "tech-writer", exact: true }).count(), 0);
    await page.getByTestId("task-assignee").selectOption("software-engineer");
    await until(() => f.store.task(id)?.interaction?.handoff?.agent === "software-engineer", "durable pending handoff");
    assert.equal(f.store.task(id).agent, "pr-updater", "Active turn must not be interrupted");
    assert.equal(existsSync(path.join(f.root, "provider-software-engineer.json")), false);
    writeFileSync(path.join(f.root, "release-pr-updater"), "finish first turn");
    await until(() => existsSync(path.join(f.root, "provider-software-engineer.json")), "receiving agent launch");
    const handed = f.store.task(id), second = provider("software-engineer");
    assert.equal(handed.id, original.id);
    assert.equal(handed.session_id, original.session_id);
    assert.equal(second.session, first.session);
    assert.equal(handed.prompt, original.prompt);
    assert.equal(handed.workspace, original.workspace);
    assert.ok(!second.input.includes("Assigned from the Tasks view"), "Audit comments must not be injected");
    assert.ok(!second.input.includes("## Work item history"));
    writeFileSync(path.join(f.root, "release-software-engineer"), "finish receiving turn");
    await until(() => f.store.task(id)?.status === "completed" && f.store.task(id)?.turns === 2, "completed assignment");
    assert.equal(f.store.tasks().filter(task => task.id.startsWith("manual-")).length, 1, "Retry must not duplicate work");
    await page.reload();
    await page.getByRole("heading", { name: "UI assignment verification", exact: true }).waitFor();
    await page.getByText("Reopen this task before changing its assignee or sending messages. Reopening prepares its original workspace.", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("task-assignee").isDisabled(), true);
    await page.goto(origin + "/tasks");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await creation.waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Form must fit mobile viewport");
    assert.deepEqual(errors, []);
    assert.ok(existsSync(path.join(f.root, "controls", "paused", "tech-writer")));
    console.log(JSON.stringify({ created: id, assignedAgent: handed.agent, sessionPreserved: true,
      instructionsPreserved: true, workItemCount: 1, interactive: false, noUiBranding: true, mobileFits: true }));
  } catch (error) {
    console.error(diagnostics);
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) console.error(JSON.stringify({ url: page.url(), body: (await page.locator("body").innerText()).slice(0, 8000) }));
    throw error;
  } finally {
    await browser?.close();
    for (const agent of ["pr-updater", "software-engineer"]) writeFileSync(path.join(f.root, `release-${agent}`), "finish owned fixture");
    await until(() => f.store.tasks().every(task => ["completed", "failed"].includes(task.status)), "fixture agents finish");
    writeFileSync(path.join(f.root, "stop-http"), "stop owned test listener");
    await httpClosed;
    if (daemon.exitCode === null) daemon.kill();
    await daemonClosed;
    cleanup();
  }
});
