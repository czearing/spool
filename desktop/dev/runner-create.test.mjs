import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const engine = process.env.SPOOL_TEST_RUNNERS_HOME;
test("adds, saves and executes project-isolated runners through shared blocks", { skip: !engine, timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-runner-browser-")), previous = { ...process.env };
  const projects = ["source", "target"].map(id => ({ id, name: id, root: join(root, id) }));
  let server, browser;
  const supervisors = [];
  t.after(async () => {
    await browser?.close(); await server?.close();
    for (const child of supervisors) {
      if (child.exitCode !== null) continue;
      const exited = once(child, "close"); child.stdin.end("stop\n"); await exited;
    }
    await rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  process.env.SPOOL_DATA_DIR = root;
  await writeFile(join(root, "connections.json"), JSON.stringify({ SPOOL_PROJECTS_FILE: join(root, "projects.json"),
    SPOOL_RUNNERS_HOME: engine, SPOOL_RUNNERS_CONFIG: join(root, "unconfigured.json") }));
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects }));
  for (const project of projects) {
    for (const folder of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed", ".runner/automation"])
      await mkdir(join(project.root, folder), { recursive: true });
    await writeFile(join(project.root, "agents", `${project.id}-agent.md`), "---\n---\nIsolated fixture; never run a model.");
    const runtime = join(project.root, ".runner", "automation"), config = join(runtime, "spool-runners.json");
    await writeFile(config, JSON.stringify({ spool_dir: project.root, node_binary: process.execPath, custom_runners: {} }));
    const child = spawn(process.execPath, [join(engine, "bridge", "workflow-supervisor.mjs"), config], {
      windowsHide: true, stdio: ["pipe", "inherit", "inherit"], env: { ...process.env,
        SPOOL_DIR: project.root, SPOOL_RUNNERS_HOME: engine, SPOOL_RUNNERS_RUNTIME: runtime },
    });
    supervisors.push(child);
    await once(child, "spawn");
  }
  server = await createServer({ root: resolve(import.meta.dirname, ".."), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } }), page = await context.newPage();
  await page.goto(`${origin}/#/target/runners/new`);
  const sidebar = page.getByRole("navigation", { name: "Project navigation" }).first();
  await expect(sidebar.getByText("All runners", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "Add runner", exact: true })).toBeEnabled();
  await expect(sidebar.getByText("No runners yet", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByText("Loading runners...", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Runner settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Runner settings", exact: true });
  await settings.getByRole("textbox", { name: "Runner name", exact: true }).fill("Spool fixture");
  await settings.getByRole("textbox", { name: "Working directory", exact: true }).fill(projects[1].root);
  await expect(settings.getByRole("checkbox", { name: "Enabled", exact: true })).not.toBeChecked();
  await settings.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Add first step", exact: true }).click();
  await page.getByRole("button", { name: /Run manually Start a run/ }).click();
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByRole("button", { name: /Edit data Build JSON/ }).click();
  await page.getByRole("textbox", { name: "Output JSON", exact: true }).fill('{"message":"isolated Spool execution"}');
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByRole("button", { name: /Run script Run PowerShell/ }).click();
  await page.getByRole("textbox", { name: "PowerShell command", exact: true })
    .fill("$inputData = $env:SPOOL_INPUT | ConvertFrom-Json; Set-Content proof.txt $inputData.message; $env:SPOOL_INPUT");
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  const savedResponse = page.waitForResponse(response => response.url().includes("/api/projects/target/runners/") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const response = await savedResponse;
  assert.equal(response.status(), 201, await response.text());
  const saved = await response.json(), api = `${origin}/api/projects/target/runners/${saved.id}`;
  await expect(page).toHaveURL(`${origin}/#/target/runners/${saved.id}`);
  await expect(sidebar.getByRole("link", { name: "Spool fixture", exact: true })).toHaveAttribute("aria-current", "page");
  assert.deepEqual((await new AxeBuilder({ page }).include('nav[aria-label="Project navigation"]').analyze()).violations, []);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Spool fixture", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Runner settings", exact: true }).click();
  await settings.getByRole("textbox", { name: "Runner name", exact: true }).fill("Unsaved change");
  await settings.getByRole("button", { name: "Done", exact: true }).click();
  await sidebar.getByRole("button", { name: "Add runner", exact: true }).click();
  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unsaved change", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Runner settings", exact: true }).click();
  await settings.getByRole("textbox", { name: "Runner name", exact: true }).fill("Spool fixture");
  await settings.getByRole("button", { name: "Done", exact: true }).click();
  const accepted = page.waitForResponse(response => response.url().endsWith("/runs") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Execute workflow", exact: true }).click();
  const queued = await accepted;
  assert.equal(queued.status(), 202, await queued.text());
  const execution = await queued.json();
  await expect.poll(async () => (await (await page.request.get(`${api}/runs?execution=${execution.id}`)).json()).status,
    { timeout: 25000 }).toBe("succeeded");
  assert.equal((await readFile(join(projects[1].root, "proof.txt"), "utf8")).trim(), "isolated Spool execution");
  const record = await (await page.request.get(`${api}/runs?execution=${execution.id}`)).json();
  assert.deepEqual(saved.nodes.map(node => node.kind), ["manual", "data", "command"]);
  assert.equal(record.steps.length, 2);
  assert.equal(record.steps.at(-1).output.message, "isolated Spool execution");
  assert.equal((await page.request.get(`${origin}/api/projects/source/runners/${saved.id}`)).status(), 404);
  const sourceConfig = join(projects[0].root, ".runner", "automation", "spool-runners.json");
  assert.deepEqual(JSON.parse(await readFile(sourceConfig, "utf8")).custom_runners, {});
  assert.deepEqual(await readdir(join(projects[0].root, ".runner", "automation", "runners")), []);
  const duplicate = await page.request.post(`${origin}/api/projects/source/runners/${saved.id}`, {
    headers: { Origin: origin }, data: { ...saved, workspace: projects[0].root, revision: "" } });
  assert.equal(duplicate.status(), 201, await duplicate.text());
  const sourceRuns = await (await page.request.get(`${origin}/api/projects/source/runners/${saved.id}/runs`)).json();
  assert.deepEqual(sourceRuns, [], "Even identical runner IDs must have isolated history and queues.");
  await expect(page.getByText("Execution succeeded", { exact: true })).toBeVisible();
  if (process.env.SPOOL_TEST_ARTIFACTS) await page.screenshot({ path: join(process.env.SPOOL_TEST_ARTIFACTS, "runner-created-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  const mobile = page.getByRole("dialog", { name: "Project navigation" });
  await mobile.getByRole("button", { name: "Add runner", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/#/target/runners/new`);
  await expect(page.getByRole("heading", { name: "New runner", exact: true })).toBeVisible();
});
