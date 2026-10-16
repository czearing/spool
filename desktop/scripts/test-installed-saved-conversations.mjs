import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expect } from "@playwright/test";
import { installedApp } from "./installed-app.mjs";

const source = process.env.SPOOL_TEST_PROJECT_ROOT;
if (!source || !isAbsolute(source)) throw new Error("Set SPOOL_TEST_PROJECT_ROOT to the saved project to verify read-only.");
const fixture = await mkdtemp(join(tmpdir(), "spool saved conversations "));
const root = join(fixture, "project"), registry = join(fixture, "projects.json");
const project = "saved-conversations-test";
const app = installedApp({ fixture, registry, projectId: project, projectName: "Saved Conversations Test" });
const originals = new Map(), tasks = [];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function copyOriginal(from, to) {
  originals.set(from, hash(await readFile(from)));
  await copyFile(from, to);
}
try {
  for (const folder of ["agents", "controls", "logs", "usage", ...["incoming", "in_progress", "completed", "failed"].map(q => join("queues", q))])
    await mkdir(join(root, folder), { recursive: true });
  await writeFile(registry, JSON.stringify({ version: 1, projects: [{ id: project, name: "Saved Conversations Test", root }] }));
  for (const queue of ["completed", "failed"]) {
    for (const name of await readdir(join(source, "queues", queue))) {
      if (!name.endsWith(".json")) continue;
      const file = join(source, "queues", queue, name), task = JSON.parse(await readFile(file, "utf8"));
      assert.equal(task.status, queue, "Only settled saved tasks may be copied into the isolated read fixture.");
      await copyOriginal(file, join(root, "queues", queue, name));
      await copyOriginal(join(source, "logs", `${task.id}.log`), join(root, "logs", `${task.id}.log`));
      await copyOriginal(join(source, "agents", `${task.agent}.md`), join(root, "agents", `${task.agent}.md`));
      tasks.push(task);
    }
  }
  assert.ok(tasks.length > 0);
  for (let launch = 0; launch < 2; launch++) {
    const page = await app.start();
    for (const task of tasks) {
      const url = `http://tauri.localhost/#/${project}/agents/${encodeURIComponent(task.agent)}?task=${encodeURIComponent(task.id)}`;
      await page.goto(url);
      const list = page.getByRole("list", { name: "Conversation messages", exact: true });
      await expect(list).toHaveAttribute("data-message-count", /^[1-9]\d*$/, { timeout: 30000 });
      await expect(page.getByText("Loading conversation...", { exact: true })).toHaveCount(0);
      if (task.error) await expect(page.getByRole("main").getByRole("alert")).toHaveText(task.error);
      else await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
      await page.reload();
      await expect(list).toHaveAttribute("data-message-count", /^[1-9]\d*$/, { timeout: 30000 });
      await expect(page.getByText("Loading conversation...", { exact: true })).toHaveCount(0);
    }
    await app.screenshot("spool-saved-conversations-loaded");
    await app.stop();
  }
  for (const [file, digest] of originals) assert.equal(hash(await readFile(file)), digest, "Original saved data changed.");
  for (const queue of ["incoming", "in_progress"]) assert.deepEqual(await readdir(join(root, "queues", queue)), []);
  console.log(`PASS: ${tasks.length} exact saved conversations open and reload across two cold launches; original task, transcript and agent files are unchanged, and no tasks were started.`);
} finally {
  await app.stop();
  try {
    const capability = JSON.parse(await readFile(join(root, "controls", "capabilities.json"), "utf8"));
    assert.ok(Number.isSafeInteger(capability.pid) && capability.pid > 0);
    const literal = root.replaceAll("'", "''");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${capability.pid}"; if($p) {
if(-not $p.CommandLine.Contains('${literal}')) { throw 'Not the isolated test daemon' }; Stop-Process -Id ${capability.pid} }`],
    { windowsHide: true });
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await rm(fixture, { recursive: true, force: true });
}
