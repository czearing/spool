import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { installedApp } from "./installed-app.mjs";

const fixture = await mkdtemp(join(tmpdir(), "spool conversation loading "));
const root = join(fixture, "project"), registry = join(fixture, "projects.json"), taskId = "conversation-history";
const app = installedApp({ fixture, registry, projectId: "conversation-test", projectName: "Conversation Test" });
const powershell = script => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
  { windowsHide: true, encoding: "utf8" }).trim();
let page;
async function openConversation() {
  await page.getByRole("navigation", { name: "Conversations", exact: true })
    .getByRole("link", { name: "Saved long conversation", exact: true }).click();
}
async function loaded() {
  await expect(page.getByRole("article", { name: "history-reader message", exact: true })
    .filter({ hasText: "LATEST_SAVED_REPLY" })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("textbox", { name: "Message agent", exact: true }))
    .not.toHaveAttribute("aria-placeholder", "Loading conversation...");
  await expect(page.getByRole("list", { name: "Conversation messages", exact: true }).getByRole("listitem").last())
    .toContainText("LATEST_SAVED_REPLY");
  await expect(page.getByRole("article", { name: "You message", exact: true })
    .filter({ hasText: "RESOLVED_OLD_RECOVERY" })).toHaveCount(0);
}
try {
  for (const folder of ["agents", "controls", "logs", "usage", "queues\\incoming", "queues\\in_progress", "queues\\completed", "queues\\failed"])
    await mkdir(join(root, folder), { recursive: true });
  await writeFile(registry, JSON.stringify({ version: 1, projects: [{ id: "conversation-test", name: "Conversation Test", root }] }));
  await writeFile(join(root, "agents", "history-reader.md"), "# History reader\nNo task execution is needed.\n");
  const start = Date.now() - 600000, at = seconds => new Date(start + seconds * 1000).toISOString();
  const timestamp = at(0), taskFile = join(root, "queues", "completed", `${taskId}.json`);
  const savedTask = JSON.stringify({
    id: taskId, agent: "history-reader", title: "Saved long conversation", prompt: "Saved initial message",
    status: "completed", session_id: null, created_at: timestamp, updated_at: timestamp, comments: [], cost: {}, turns: 1,
    interaction: { messages: [
      { id: "resolved-old", text: "RESOLVED_OLD_RECOVERY", status: "retried", created_at: at(0.5) },
      { id: "resolved-recent", text: "RESOLVED_RECENT_RECOVERY", status: "dismissed", created_at: at(356.5) },
    ] },
  });
  await writeFile(taskFile, savedTask);
  const events = [];
  for (let index = 0; index < 180; index++) {
    events.push({ timestamp: at(index * 2), type: "user.message", data: { content: `Saved message ${index}` } });
    events.push({ timestamp: at(index * 2 + 1), type: "assistant.message", data: {
      content: index === 179 ? "LATEST_SAVED_REPLY" : `Saved reply ${index}: ${"history ".repeat(250)}`,
    } });
  }
  const log = events.map(event => JSON.stringify(event)).join("\n") + "\n";
  assert.ok(Buffer.byteLength(log) > 256 * 1024);
  await writeFile(join(root, "logs", `${taskId}.log`), log);
  for (let launch = 0; launch < 2; launch++) {
    page = await app.start();
    page.on("pageerror", error => console.error("Installed conversation error:", error.message));
    page.on("console", message => { if (message.type() === "error") console.error("Installed console:", message.text()); });
    await page.goto(`http://tauri.localhost/#/conversation-test/agents/history-reader?task=${taskId}`);
    await loaded();
    await page.reload(); await loaded();
    if (launch === 0) await app.stop();
  }
  console.log("PASS: real installed app loads a transcript larger than its paging window across cold launches and reloads.");
  const viewport = page.getByRole("region", { name: "Task conversation", exact: true });
  const list = page.getByRole("list", { name: "Conversation messages", exact: true });
  await viewport.evaluate(element => { element.scrollTop = 0; });
  await expect(list).toHaveAttribute("data-has-more", "false", { timeout: 30000 });
  await viewport.evaluate(element => { element.scrollTop = 0; });
  const historical = list.getByRole("listitem").filter({ hasText: "RESOLVED_OLD_RECOVERY" });
  await expect(historical).toBeVisible();
  await expect(historical).toHaveAttribute("aria-posinset", "3");
  await expect(historical).toContainText("Resent by you");
  await expect(list).toHaveAttribute("data-message-count", "363");
  await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await loaded();
  await app.screenshot("spool-chronological-recovery");
  console.log("PASS: resolved recovery stays in its original historical position across pagination; the latest reply remains last after cold launches and reloads.");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What would you like to work on?" })).toBeVisible();
  app.suspendBackend(true);
  await openConversation();
  await expect(page.getByRole("main").getByRole("alert"))
    .toContainText("Conversation loading timed out", { timeout: 22000 });
  await expect(page.getByRole("textbox", { name: "Message agent", exact: true }))
    .toHaveAttribute("aria-placeholder", "Conversation unavailable.");
  await app.screenshot("spool-conversation-timeout");
  app.suspendBackend(false);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await loaded();
  assert.equal(await readFile(join(root, "logs", `${taskId}.log`), "utf8"), log);
  assert.equal(await readFile(taskFile, "utf8"), savedTask);
  await app.screenshot("spool-conversation-recovered");
  console.log("PASS: a genuinely stalled installed backend produces an actionable timeout; retry restores the saved conversation without modifying it.");
} catch (error) {
  await app.screenshot("spool-conversation-loading-failure");
  if (page && !page.isClosed()) console.error("Conversation UI:", (await page.getByRole("main").innerText()).slice(-1800));
  throw error;
} finally {
  await app.stop();
  try {
    const capability = JSON.parse(await readFile(join(root, "controls", "capabilities.json"), "utf8"));
    assert.ok(Number.isSafeInteger(capability.pid) && capability.pid > 0);
    const escaped = root.replaceAll("'", "''");
    powershell(`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${capability.pid}";
if($p) { if(-not $p.CommandLine.Contains('${escaped}')) { throw 'Not fixture runtime' }; Stop-Process -Id ${capability.pid} }`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await rm(fixture, { recursive: true, force: true });
}
