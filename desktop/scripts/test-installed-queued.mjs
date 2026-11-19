import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { installedApp } from "./installed-app.mjs";

const fixture = await mkdtemp(join(tmpdir(), "spool installed queued "));
const root = join(fixture, "project"), registry = join(fixture, "projects.json");
const app = installedApp({ fixture, registry, projectId: "queued-test", projectName: "Queued Test" });
const shell = command => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
  { windowsHide: true, encoding: "utf8" }).trim();
let page, taskId;
async function task() {
  for (const queue of ["in_progress", "incoming", "completed", "failed"]) {
    try {
      const value = JSON.parse(await readFile(join(root, "queues", queue, `${taskId}.json`), "utf8"));
      assert.notEqual(queue, "failed", `Real Copilot task failed: ${value.error}`);
      return value;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error("Submitted fixture task disappeared");
}
const events = async () => (await readFile(join(root, "logs", `${taskId}.log`), "utf8"))
  .split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
async function waiters() {
  const value = await task();
  assert.ok(Number.isSafeInteger(value.provider?.pid));
  return JSON.parse(shell(`$all=Get-CimInstance Win32_Process; $ids=@(${value.provider.pid});
for($i=0;$i -lt 8;$i++) {
 $next=@($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId });
 if(-not $next.Count) { break }; $ids+=@($next.ProcessId)
};
$owned=@($all | Where-Object { $ids -contains $_.ProcessId -and $_.Name -eq 'powershell.exe' -and
 $_.CommandLine.Contains('Start-Sleep -Seconds 900') } | Select-Object -ExpandProperty ProcessId);
ConvertTo-Json -InputObject $owned`));
}
async function reply(token) {
  await expect(page.getByRole("article", { name: "queue-check message", exact: true }).filter({ hasText: token }))
    .toBeVisible({ timeout: 120000 });
}
try {
  for (const folder of ["agents", "controls", "logs", "usage", ...["incoming", "in_progress", "completed", "failed"].map(q => join("queues", q))])
    await mkdir(join(root, folder), { recursive: true });
  await writeFile(registry, JSON.stringify({ version: 1, projects: [{ id: "queued-test", name: "Queued Test", root }] }));
  await writeFile(join(root, "agents", "queue-check.md"),
    "---\nmodel: gpt-6.1-sol\nmax_concurrent: 1\n---\n" +
    "You are an isolated ACP lifecycle probe. Only do exactly what each message requests. Do not inspect or modify files. " +
    "When asked to start a waiter, use powershell with command Start-Sleep -Seconds 900, mode async, detach false, " +
    "and the requested shellId. Then immediately emit the exact requested final answer. Do not wait for the sleeper. " +
    "Never stop earlier waiters. For a message requesting only a reply, use no tools.\n");
  page = await app.start();
  await page.goto("http://tauri.localhost/#/queued-test/agents/queue-check");
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await expect(editor).toBeEditable();
  await editor.fill("Start an attached waiter with shellId queued-first, then final answer SPOOL_QUEUE_FIRST_DONE.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page).toHaveURL(/\?task=manual-/, { timeout: 30000 });
  taskId = new URL(page.url().split("#")[1], "http://fixture").searchParams.get("task");
  await reply("SPOOL_QUEUE_FIRST_DONE");
  const first = await task();
  assert.equal(first.interaction.phase, "running", "The real attached waiter must keep the first ACP turn open");
  assert.ok(first.session_id && first.provider?.pid);
  const firstWaiters = await waiters();
  assert.equal(firstWaiters.length, 1);
  console.log("PASS: real Copilot wrote its final answer while an actual attached process kept its ACP turn open.");
  for (const [index, token, text] of [
    [1, "SPOOL_QUEUE_SECOND_DONE", "Start another attached waiter with shellId queued-second, then final answer SPOOL_QUEUE_SECOND_DONE."],
    [2, "SPOOL_QUEUE_THIRD_DONE", "Reply with exactly SPOOL_QUEUE_THIRD_DONE. Do not use tools or stop earlier waiters."],
  ]) {
    await expect(editor).toBeEditable();
    await editor.fill(text);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(editor).toBeEmpty({ timeout: 30000 });
    await expect.poll(async () => (await task()).interaction.messages?.at(-1)?.status, { timeout: 30000 }).toBe("delivered");
    await reply(token);
    const current = await task();
    assert.equal(current.session_id, first.session_id);
    assert.equal(current.provider.pid, first.provider.pid, "Continuation must not restart the provider");
    assert.equal(current.interaction.messages.length, index);
    assert.ok(current.interaction.messages.every(message => message.status === "delivered"));
    const log = await events();
    for (const message of current.interaction.messages)
      assert.equal(log.filter(event => event.type === "user.message" && event.data.messageId === message.id).length, 1);
    assert.equal(log.filter(event => event.type === "session.continuation_requested").length, index);
    const live = await waiters();
    assert.ok(firstWaiters.every(pid => live.includes(pid)), "Original attached work must remain alive");
    assert.equal(live.length, 2, "Both attached waiters must survive continuation");
    console.log(`PASS: queued continuation ${index} is delivered once and gets a genuine reply in the same provider process/session; attached work is preserved.`);
  }
  await page.reload();
  await reply("SPOOL_QUEUE_THIRD_DONE");
  assert.equal((await task()).interaction.messages.length, 2);
  assert.equal((await readdir(join(root, "queues", "in_progress"))).length, 1);
  await app.screenshot("spool-repeated-queued-continuation");
  console.log("PASS: repeated queued recovery persists after UI reload without manual requeue, replay, process termination, or fabricated delivery.");
} catch (error) {
  await app.screenshot("spool-queued-continuation-failure");
  if (taskId) console.error("Fixture task:", JSON.stringify(await task()));
  throw error;
} finally {
  await app.stop();
  try {
    const capability = JSON.parse(await readFile(join(root, "controls", "capabilities.json"), "utf8"));
    assert.ok(Number.isSafeInteger(capability.pid) && capability.pid > 0);
    const literal = root.replaceAll("'", "''");
    shell(`$ErrorActionPreference='Stop'; $all=Get-CimInstance Win32_Process; $runtime=$all | Where-Object {$_.ProcessId -eq ${capability.pid}};
if($runtime) {
 if(-not $runtime.CommandLine.Contains('${literal}')) { throw 'Not the isolated queued fixture runtime' };
 $ids=@(${capability.pid});
 for($i=0;$i -lt 16;$i++) { $next=@($all | Where-Object {$ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId});
  if(-not $next.Count) { break }; $ids+=@($next.ProcessId) };
 [array]::Reverse($ids); foreach($id in $ids) { Stop-Process -Id $id -ErrorAction SilentlyContinue };
 foreach($id in $ids) { $process=Get-Process -Id $id -ErrorAction SilentlyContinue;
  if($process -and -not $process.WaitForExit(5000)) { throw "Fixture process $id did not stop" } }
}; exit 0`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
