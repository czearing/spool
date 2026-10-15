import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect } from "@playwright/test";
import { installedApp } from "./installed-app.mjs";

const fixture = await mkdtemp(join(tmpdir(), "spool installed send "));
const root = join(fixture, "project"), registry = join(fixture, "projects.json");
const app = installedApp({ fixture, registry, projectId: "send-test", projectName: "Send Test" });
const capability = async () => JSON.parse(await readFile(join(root, "controls", "capabilities.json"), "utf8"));
let page, taskId;
async function stopRuntime() {
  let value;
  try { value = await capability(); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { value = { pid: Number((await readFile(join(root, ".runner", "daemon.lock"), "utf8")).trim()) }; }
    catch (failure) { if (failure.code === "ENOENT") return; throw failure; }
  }
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
  const literal = root.replaceAll("'", "''");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process); ` +
    `$runtime=$all | Where-Object { $_.ProcessId -eq ${value.pid} }; if (-not $runtime) { exit 0 }; ` +
    `if (-not $runtime.CommandLine.Contains('${literal}')) { throw 'Refusing to stop a non-fixture runtime' }; ` +
    `$ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${value.pid}); ` +
    `do { $added=$false; foreach($p in $all) { if($ids.Contains([int]$p.ParentProcessId)) { ` +
    `if($ids.Add([int]$p.ProcessId)) { $added=$true } } } } while($added); ` +
    `Stop-Process -Id ${value.pid}; foreach($id in $ids) { if($id -ne ${value.pid}) { ` +
    `Stop-Process -Id $id -ErrorAction SilentlyContinue } }; ` +
    `foreach($id in $ids) { $process=Get-Process -Id $id -ErrorAction SilentlyContinue; ` +
    `if($process -and -not $process.WaitForExit(5000)) { throw "Fixture process $id did not stop" } }; exit 0`],
  { windowsHide: true });
}
async function completed() {
  let task;
  try { task = JSON.parse(await readFile(join(root, "queues", "completed", `${taskId}.json`), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  try {
    const failure = JSON.parse(await readFile(join(root, "queues", "failed", `${taskId}.json`), "utf8"));
    throw new Error(`Real provider execution failed: ${JSON.stringify(failure.error)}`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return task;
}
async function reply(token) {
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  await expect(editor).toBeEditable({ timeout: 30000 });
  await editor.fill(`Reply with exactly ${token}. Do not use tools, read or change files, or run commands.`);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(editor).toBeEmpty({ timeout: 30000 });
  await expect(page.getByRole("article", { name: "runtime-check message", exact: true }).filter({ hasText: token }))
    .toBeVisible({ timeout: 120000 });
}
try {
  for (const folder of ["agents", "controls", "logs", "usage", "queues\\incoming", "queues\\in_progress", "queues\\completed", "queues\\failed"])
    await mkdir(join(root, folder), { recursive: true });
  await writeFile(registry, JSON.stringify({ version: 1, projects: [{ id: "send-test", name: "Send Test", root }] }));
  await writeFile(join(root, "agents", "runtime-check.md"),
    "---\nmodel: gpt-5.4\nmax_concurrent: 1\n---\nYou are a connectivity check. Reply with the exact acknowledgement requested. Never use tools or modify anything.\n");
  page = await app.start();
  await page.goto("http://tauri.localhost/#/send-test/agents/runtime-check");
  const editor = page.getByRole("textbox", { name: "Message agent", exact: true });
  const prompt = "Reply with exactly SPOOL_INSTALLED_SEND_OK. Do not use tools, read or change files, or run commands.";
  await mkdir(join(root, "logs", "task-runtime.stdout.log"));
  await editor.fill(prompt);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("task runtime could not start", { timeout: 30000 });
  await expect(editor).toHaveText(prompt);
  assert.equal((await readdir(join(root, "queues", "incoming"))).length, 0);
  await rmdir(join(root, "logs", "task-runtime.stdout.log"));
  await page.getByRole("button", { name: "Retry sending message", exact: true }).click();
  await expect(page).toHaveURL(/\?task=manual-/, { timeout: 30000 });
  taskId = new URL(page.url().split("#")[1], "http://fixture").searchParams.get("task");
  assert.ok(taskId?.startsWith("manual-"));
  await expect.poll(async () => (await completed())?.session_id, { timeout: 120000 }).toBeTruthy();
  const first = await completed(), runtime = await capability();
  await expect(page.getByRole("article", { name: "runtime-check message", exact: true })
    .filter({ hasText: "SPOOL_INSTALLED_SEND_OK" })).toBeVisible({ timeout: 30000 });
  assert.equal(first.error, null);
  assert.equal(runtime.interactive, true);
  console.log("PASS: actual installed UI preserves a failed-send draft, retries once, automatically starts the native daemon and displays a real Copilot reply.");
  await app.screenshot("spool-real-send");
  const dismissedId = randomUUID(), retriedId = randomUUID();
  const uncertainError = "Runner stopped before delivery could be confirmed; operator input is required before resuming";
  first.interaction.messages ??= [];
  first.interaction.messages.push(
    { id: dismissedId, text: "Do not resend this earlier message.", status: "delivery_uncertain",
      created_at: new Date().toISOString(), error: uncertainError },
    { id: retriedId, text: "Reply with exactly SPOOL_EXPLICIT_RESEND_OK. Do not use tools or modify files.",
      status: "delivery_uncertain", created_at: new Date().toISOString(), error: uncertainError },
  );
  await writeFile(join(root, "queues", "completed", `${taskId}.json`), JSON.stringify(first));
  await page.reload();
  await expect(page.getByText(uncertainError, { exact: true })).toHaveCount(0);
  const recovery = page.getByLabel("Unconfirmed message delivery", { exact: true });
  await expect(recovery).toBeVisible();
  await recovery.getByRole("button", { name: "Leave unsent", exact: true }).first().click();
  let decision = page.getByRole("dialog", { name: "Leave message unsent?", exact: true });
  await decision.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await completed()).interaction.messages[0].status, "delivery_uncertain");
  await recovery.getByRole("button", { name: "Leave unsent", exact: true }).first().click();
  decision = page.getByRole("dialog", { name: "Leave message unsent?", exact: true });
  await decision.getByRole("button", { name: "Confirm leave unsent", exact: true }).click();
  await expect(decision).not.toBeVisible();
  assert.equal((await completed()).interaction.messages[0].status, "dismissed");
  assert.equal((await completed()).interaction.messages.length, 2);
  assert.equal((await readdir(join(root, "queues", "incoming"))).length, 0);
  await recovery.getByRole("button", { name: "Resend message", exact: true }).click();
  decision = page.getByRole("dialog", { name: "Resend uncertain message?", exact: true });
  await expect(decision).toContainText("Resending can repeat work or side effects");
  await decision.getByRole("button", { name: "Confirm resend", exact: true }).click();
  await expect(decision).not.toBeVisible();
  await expect(page.getByRole("article", { name: "runtime-check message", exact: true })
    .filter({ hasText: "SPOOL_EXPLICIT_RESEND_OK" })).toBeVisible({ timeout: 120000 });
  await expect.poll(async () => (await completed())?.interaction?.messages?.at(-1)?.status, { timeout: 30000 }).toBe("delivered");
  const resolved = await completed();
  assert.equal(resolved.interaction.messages[1].status, "retried");
  assert.equal(resolved.interaction.messages.length, 3);
  assert.equal(resolved.session_id, first.session_id);
  const resendBubbles = page.getByRole("article", { name: "You message", exact: true }).filter({ hasText: "SPOOL_EXPLICIT_RESEND_OK" });
  await expect(resendBubbles).toHaveCount(2);
  await expect(resendBubbles.filter({ hasText: "Resent by you" })).toHaveCount(1);
  const resendId = resolved.interaction.messages[2].id;
  const journal = JSON.parse(await readFile(join(root, "controls", "commands", `${resendId}.json`), "utf8"));
  const receipt = join(root, "controls", "results", `${resendId}.json`);
  await rm(receipt);
  const retryFile = join(root, "controls", "requests", `${resendId}.retry`);
  await writeFile(retryFile, JSON.stringify(journal.request));
  await rename(retryFile, join(root, "controls", "requests", `${resendId}.json`));
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(receipt, "utf8")).result?.duplicate; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }).toBe(true);
  assert.equal((await completed()).interaction.messages.length, 3);
  assert.equal((await readdir(join(root, "queues", "incoming"))).length, 0);
  await expect(recovery).toHaveCount(0);
  await app.screenshot("spool-explicit-delivery-recovery");
  console.log("PASS: actual UI leaves unsent without execution, explicitly resends once in the same real provider session, and native receipt-loss retry cannot duplicate it.");
  await app.stop();
  process.kill(runtime.pid, 0);
  await setTimeout(2500);
  const afterQuit = await capability();
  assert.equal(afterQuit.pid, runtime.pid);
  assert.ok(Date.parse(afterQuit.updatedAt) > Date.parse(runtime.updatedAt));
  page = await app.start();
  await page.goto(`http://tauri.localhost/#/send-test/agents/runtime-check?task=${taskId}`);
  await reply("SPOOL_INSTALLED_FOLLOWUP_OK");
  await expect.poll(async () => (await completed())?.interaction?.messages?.at(-1)?.status, { timeout: 120000 }).toBe("delivered");
  assert.equal((await completed()).session_id, first.session_id);
  assert.equal((await capability()).pid, runtime.pid);
  console.log("PASS: task runtime survives a full desktop exit/restart; a real follow-up resumes the same saved provider session.");
  await stopRuntime();
  await expect.poll(async () => (await capability()).pid, { timeout: 30000 }).not.toBe(runtime.pid);
  await reply("SPOOL_INSTALLED_RECOVERY_OK");
  await expect.poll(async () => (await completed())?.interaction?.messages?.length, { timeout: 120000 }).toBe(5);
  await expect.poll(async () => (await completed())?.interaction?.messages?.at(-1)?.status, { timeout: 120000 }).toBe("delivered");
  assert.equal((await completed()).session_id, first.session_id);
  assert.equal((await readdir(join(root, "controls", "ui-submissions"))).length, 1);
  assert.equal((await readdir(join(root, "queues", "completed"))).length, 1);
  assert.equal((await readdir(join(root, "queues", "incoming"))).length, 0);
  assert.equal((await readdir(join(root, "queues", "in_progress"))).length, 0);
  await app.screenshot("spool-real-send-after-runtime-recovery");
  console.log("PASS: a stopped runtime is recovered automatically; real follow-ups remain in one task and one provider session without duplicate submission.");
} catch (error) {
  await app.screenshot("spool-real-send-failure");
  if (page && !page.isClosed()) console.error("Installed send UI:", (await page.getByRole("main").innerText()).slice(-3000));
  for (const directory of ["requests", "results"]) {
    try {
      for (const name of await readdir(join(root, "controls", directory)))
        if (name.endsWith(".json")) console.error(`${directory}/${name}: ${await readFile(join(root, "controls", directory, name), "utf8")}`);
    } catch (failure) { if (failure.code !== "ENOENT") console.error(failure); }
  }
  for (const name of ["task-runtime.stderr.log", ...(taskId ? [`${taskId}.log`] : [])]) {
    try { console.error(`${name}:\n${(await readFile(join(root, "logs", name), "utf8")).slice(-6000)}`); }
    catch (failure) { if (failure.code !== "ENOENT") console.error(failure); }
  }
  throw error;
} finally {
  await app.stop();
  await stopRuntime();
  await rm(fixture, { recursive: true, force: true });
}
