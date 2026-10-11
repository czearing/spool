import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { writeJson } from "../spool-store.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}
test("native live chat, reconnect, steering, graceful board moves and lightweight navigation", {
  skip: !process.env.SPOOL_CHAT_SPOOL_BINARY || !process.env.SPOOL_CHAT_HTTP_BINARY || !process.env.SPOOL_MONITOR_DIST,
  timeout: 180000,
}, async t => {
  const cleanup = [];
  const f = fixture({ after: callback => cleanup.push(callback) }), listenPort = await port(), origin = `http://127.0.0.1:${listenPort}`;
  const fakeBin = path.join(f.root, "bin"), fakeLoader = path.join(fakeBin, "node_modules", "@github", "copilot");
  mkdirSync(fakeLoader, { recursive: true });
  copyFileSync(path.join(import.meta.dirname, "fixtures", "chat-provider.cjs"), path.join(fakeLoader, "npm-loader.js"));
  writeFileSync(path.join(f.root, "fixture-only"), "No production agents or repositories");
  writeFileSync(path.join(f.root, "agents", "pr-updater.md"), "---\nmodel: fixture-model\n---\nFixture role. Never use real tools.");
  const env = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, SPOOL_INTERACTIVE_ACP: "1",
    SPOOL_CHAT_FIXTURE: f.root, SPOOL_HTTP_TEST_ROOT: f.root, SPOOL_HTTP_TEST_PORT: String(listenPort) };
  const daemon = spawn(process.env.SPOOL_CHAT_SPOOL_BINARY, ["--root", f.root, "daemon"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const http = spawn(process.env.SPOOL_CHAT_HTTP_BINARY,
    ["dashboard::server::tests::isolated_interactive_http_fixture", "--ignored", "--exact", "--nocapture"],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  for (const child of [daemon, http]) for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { diagnostics += data; });
  let browser, page;
  const errors = [], requests = [];
  t.after(async () => {
    await browser?.close();
    for (const id of ["chat-live", "board-live"]) writeFileSync(path.join(f.root, `release-${id}`), "finish fixture");
    await delay(500);
    writeFileSync(path.join(f.root, "stop-http"), "stop isolated listener");
    await until(() => http.exitCode !== null, "isolated listener shutdown", 5000);
    if (daemon.exitCode === null) { daemon.kill(); await new Promise(resolve => daemon.once("exit", resolve)); }
    for (const finish of cleanup) await finish();
  });
  try {
    await until(async () => {
      try { return (await fetch(`${origin}/`)).ok; }
      catch (error) { if (error.cause?.code !== "ECONNREFUSED") throw error; return false; }
    }, "isolated native HTTP");
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true, channel: "msedge" });
    page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", req => requests.push(req.url()));
    await page.goto(`${origin}/SPOOL/dashboard`, { waitUntil: "networkidle" });
    assert.equal(new URL(page.url()).pathname, "/");
    assert.equal(requests.some(url => url.includes("ChatConversation-")), false, "Chat must stay out of dashboard load");
    const initialScripts = requests.filter(url => new URL(url).pathname.endsWith(".js"));
    let initialBytes = 0;
    for (const url of initialScripts) initialBytes += (await (await fetch(url)).arrayBuffer()).byteLength;
    assert.ok(initialBytes <= 475418, `Initial JavaScript grew: ${initialBytes}`);

    f.put({ id: "chat-live", prompt: "Original fixture task instructions" });
    await until(() => {
      const task = f.store.task("chat-live");
      if (task?.status === "failed") throw new Error(task.error);
      return existsSync(path.join(f.root, "prompts-chat-live.jsonl"));
    }, "first ACP turn");
    await page.goto(`${origin}/tasks/chat-live`, { waitUntil: "domcontentloaded" });
    await page.getByText("Live stream connected", { exact: true }).waitFor();
    await page.getByText("Streaming turn 1: inspecting now", { exact: true }).waitFor();
    await page.getByText("Inspect workspace", { exact: true }).waitFor();
    await page.getByText("No result recorded", { exact: true }).waitFor();
    const snapshotRequests = requests.filter(url => url.includes("/api/monitor/task?")).length;
    await delay(5500);
    assert.equal(requests.filter(url => url.includes("/api/monitor/task?")).length, snapshotRequests, "Transcript must not poll");
    const firstPrompt = JSON.parse(readFileSync(path.join(f.root, "prompts-chat-live.jsonl"), "utf8").trim())[0].text;
    assert.equal(firstPrompt, "Fixture role. Never use real tools.\n\nOriginal fixture task instructions");

    const options = await (await fetch(`${origin}/api/monitor/control-options`)).json();
    assert.equal(options.enabled, true);
    assert.equal(options.statusEnabled, true, "ACP must retain Kanban controls");
    const headers = { "content-type": "application/json", "x-spool-token": options.token, origin };
    const rejected = await fetch(`${origin}/api/monitor/tasks/chat-live/message`, {
      method: "POST", headers: { ...headers, origin: "https://invalid.example" }, body: JSON.stringify({ id: randomUUID(), message: "Reject" }),
    });
    assert.equal(rejected.status, 403);
    const attempts = [];
    await page.route("**/api/monitor/tasks/chat-live/message", async route => {
      attempts.push(route.request().postDataJSON().id);
      if (attempts.length === 1) await route.fulfill({ status: 503, body: "Temporary fixture failure" });
      else await route.continue();
    });
    await page.getByRole("textbox", { name: "Message pr-updater", exact: true }).fill("Please inspect the next step");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("Temporary fixture failure", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await until(() => f.store.task("chat-live")?.interaction?.messages?.[0]?.status === "queued", "durable queued message");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], attempts[1], "Retries must reuse the same command identity");
    assert.equal(readFileSync(path.join(f.root, "prompts-chat-live.jsonl"), "utf8").trim().split("\n").length, 1, "No overlapping prompts");
    writeFileSync(path.join(f.root, "release-chat-live"), "finish current turn");
    await page.getByText("Streaming turn 2: inspecting now", { exact: true }).waitFor();
    await until(() => f.store.task("chat-live")?.status === "completed", "completed ACP task");
    const saved = f.store.task("chat-live"), prompts = readFileSync(path.join(f.root, "prompts-chat-live.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(prompts[1][0].text, "Please inspect the next step");
    assert.equal(saved.interaction.messages[0].status, "delivered");
    assert.equal(saved.cost.input_tokens, 20);
    assert.equal(saved.turns, 2);
    assert.equal(saved.provider, null);
    await page.getByText("Task instructions, workspace, usage, and audit notes", { exact: true }).click();
    await page.getByText("Input tokens: 20", { exact: true }).waitFor();
    await until(() => page.getByRole("textbox", { name: "Message pr-updater", exact: true }).isDisabled(), "historical composer disabled");
    await page.getByText("Task instructions, workspace, usage, and audit notes", { exact: true }).click();

    const append = (content, name = "chat-live") => appendFileSync(path.join(f.root, "logs", `${name}.log`),
      JSON.stringify({ type: "assistant.message", timestamp: new Date().toISOString(), data: { content } }) + "\n");
    await page.context().setOffline(true);
    append("Reconnect preserved this output");
    await page.context().setOffline(false);
    await page.getByText("Reconnect preserved this output", { exact: true }).waitFor();
    assert.equal(await page.getByText("Reconnect preserved this output", { exact: true }).count(), 1);
    const started = Date.now();
    append("Latency check output");
    await page.getByText("Latency check output", { exact: true }).waitFor();
    const latency = Date.now() - started;
    assert.ok(latency < 2000, `Live output latency ${latency}ms`);
    f.put({ id: "chat-other", agent: "pr-updater", prompt: "Unrelated work item instructions" }, "completed");
    append("Other work item only", "chat-other");
    await until(async () => (await page.getByRole("combobox", { name: "Work item", exact: true })
      .locator('option[value="chat-other"]').count()) === 1, "same-agent task selector refresh");
    await page.getByRole("combobox", { name: "Work item", exact: true }).selectOption("chat-other");
    await page.getByText("Other work item only", { exact: true }).waitFor();
    assert.equal(await page.getByText("Latency check output", { exact: true }).count(), 0, "Unrelated tasks must never share displayed history");
    await page.getByRole("combobox", { name: "Work item", exact: true }).selectOption("chat-live");
    await page.getByText("Latency check output", { exact: true }).waitFor();
    assert.equal(await page.getByText("Other work item only", { exact: true }).count(), 0);
    writeFileSync(path.join(f.root, "logs", "chat-live.log"),
      JSON.stringify({ type: "assistant.message", data: { content: "Rotated log output" } }) + "\n");
    await page.getByText("Rotated log output", { exact: true }).waitFor();
    assert.equal(await page.getByText("Latency check output", { exact: true }).count(), 0);
    appendFileSync(path.join(f.root, "logs", "chat-live.log"), Array.from({ length: 240 }, (_, i) =>
      JSON.stringify({ type: "assistant.message", data: { content: `Bounded history ${i}: ${"x".repeat(2200)}` } }) + "\n").join(""));
    await until(() => page.getByRole("button", { name: "Older output", exact: true }).isEnabled(), "bounded history paging");
    await page.getByRole("button", { name: "Older output", exact: true }).click();
    await page.getByText("Historical page - live updates paused", { exact: true }).waitFor();
    append("Output while viewing history");
    await delay(600);
    assert.equal(await page.getByText("Output while viewing history", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Latest", exact: true }).click();
    await page.getByText("Output while viewing history", { exact: true }).waitFor();

    f.put({ id: "board-live" });
    await until(() => existsSync(path.join(f.root, "prompts-board-live.jsonl")), "board fixture running");
    const move = { id: randomUUID(), kind: "status", taskId: "board-live", expectedStatus: "in_progress", status: "completed" };
    const response = await fetch(`${origin}/api/monitor/control`, { method: "POST", headers, body: JSON.stringify(move) });
    assert.equal(response.status, 202);
    await until(() => f.store.task("board-live")?.status === "completed", "graceful board transition");
    assert.ok(existsSync(path.join(f.root, "cancelled-board-live")));
    const result = await until(async () => {
      const receipt = await (await fetch(`${origin}/api/monitor/control-result?id=${move.id}`)).json();
      return receipt.result && receipt;
    }, "persisted board receipt");
    assert.equal(result.result.status, "accepted");
    await page.goto(`${origin}/tasks`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Active work", exact: true }).waitFor();
    await page.getByRole("heading", { name: "All work", exact: true }).waitFor();
    assert.doesNotMatch(await page.locator("body").innerText(), /paperclip|cairn|harness/i);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ initialJavaScriptBytes: initialBytes, appendToRenderMs: latency, steering: "delivered", board: "gracefully completed", reconnect: "resumed", rotation: "reloaded" }));
  } catch (error) {
    console.error(diagnostics);
    console.error(JSON.stringify({ fixtureTasks: f.store.tasks() }));
    const log = path.join(f.root, "logs", "chat-live.log");
    if (existsSync(log)) console.error(readFileSync(log, "utf8"));
    console.error(error);
    console.error(JSON.stringify({ errors, body: page && !page.isClosed() ? (await page.locator("body").innerText()).slice(0,5000) : null }));
    throw error;
  }
});
