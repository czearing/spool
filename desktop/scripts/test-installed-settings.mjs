import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { installedApp } from "./installed-app.mjs";

const fixture = await mkdtemp(join(tmpdir(), "spool installed UI "));
const target = join(fixture, "target"), source = join(fixture, "source");
const registry = join(fixture, "projects.json");
const app = installedApp({ fixture, registry, projectId: "ui-target", projectName: "UI Target" });
let page;
const start = async () => { page = await app.start(); };
const stop = () => app.stop();
const screenshot = name => app.screenshot(name);
async function settings(agent) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  if (agent) {
    const accordion = page.getByRole("button", { name: "Agents", exact: true });
    if (await accordion.getAttribute("aria-expanded") !== "true") await accordion.click();
    const link = page.getByRole("navigation", { name: "Project navigation" }).getByRole("link", { name: agent, exact: true });
    await link.click();
    await page.getByRole("button", { name: "Agent actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  } else await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: agent ? "Agent settings" : "Settings", exact: true });
  await expect(dialog.getByRole("button", { name: "Save settings", exact: true })).toBeEnabled();
  return dialog;
}
async function chooseDifferentModel(dialog, label) {
  await dialog.getByRole("combobox", { name: label, exact: true }).click();
  const options = await page.getByRole("option").all();
  for (const option of options) {
    if (await option.getAttribute("data-state") === "checked" || await option.getAttribute("aria-disabled") === "true" ||
      (await option.innerText()).trim() === "Use project default") continue;
    const selected = (await option.innerText()).trim();
    await option.click(); return selected;
  }
  throw new Error("The real model catalog did not provide an alternative model.");
}
async function save(dialog) {
  await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
try {
  for (const root of [target, source])
    for (const folder of ["agents", "controls", "logs", "usage", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
      await mkdir(join(root, folder), { recursive: true });
  await writeFile(registry, JSON.stringify({ version: 1, projects: [
    { id: "ui-target", name: "UI Target", root: target }, { id: "ui-source", name: "UI Source", root: source },
  ] }));
  await writeFile(join(source, "agents", "library-role.md"), "# Shared UI role\nUse the supplied workspace.\n");
  await start();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText("No agents configured", { exact: true })).toHaveCount(0);
  let dialog = await settings();
  const projectModel = await chooseDifferentModel(dialog, "Default agent model");
  await save(dialog);
  assert.notEqual(JSON.parse(await readFile(join(target, "spool.json"), "utf8")).defaultModel, "gpt-5.4");
  dialog = await settings();
  await expect(dialog.getByRole("combobox", { name: "Default agent model", exact: true })).toHaveText(projectModel);
  await screenshot("spool-project-settings-after");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  console.log("PASS: installed UI saves and reopens project model settings offline; redundant sidebar message is absent.");
  await page.getByRole("button", { name: "Add agent", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Add agent", exact: true });
  await dialog.getByRole("textbox", { name: /^Name\b/ }).fill("ui-created");
  await dialog.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.waitForURL("**/agents/ui-created/prompt");
  await page.getByRole("textbox", { name: "ui-created prompt", exact: true }).fill("UI-created instructions.");
  await expect(page.getByRole("status", { name: "Prompt save status" })).toHaveText("All changes saved");
  assert.match(await readFile(join(target, "agents", "ui-created.md"), "utf8"), /UI-created instructions/);
  dialog = await settings("ui-created");
  const agentModel = await chooseDifferentModel(dialog, "Model");
  await dialog.getByRole("spinbutton", { name: "Max concurrent runs" }).fill("3");
  await save(dialog);
  assert.match(await readFile(join(target, "agents", "ui-created.md"), "utf8"), /^model:/m);
  dialog = await settings("ui-created");
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveText(agentModel);
  await expect(dialog.getByRole("spinbutton", { name: "Max concurrent runs" })).toHaveValue("3");
  await screenshot("spool-agent-settings-after");
  await dialog.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "Use project default", exact: true }).click();
  await save(dialog);
  assert.doesNotMatch(await readFile(join(target, "agents", "ui-created.md"), "utf8"), /^model:/m);
  console.log("PASS: installed UI creates an agent, saves its prompt/model/run limit, and restores project-model inheritance offline.");
  await page.getByRole("button", { name: "Add agent", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Add agent", exact: true });
  await dialog.getByRole("tab", { name: "Import from project", exact: true }).click();
  await dialog.getByRole("radio", { name: "library-role from UI Source", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Shared instructions preview" })).toContainText("Shared UI role");
  await dialog.getByRole("button", { name: "Import agent", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.goto("http://tauri.localhost/#/ui-target/agents/library-role/prompt");
  const editor = page.getByRole("textbox", { name: "library-role prompt", exact: true });
  await expect(editor).toContainText("Shared UI role");
  await editor.fill("Updated shared UI role.");
  await expect(page.getByRole("status", { name: "Prompt save status" })).toHaveText("All changes saved");
  assert.match(await readFile(join(source, "agents", "library-role.md"), "utf8"), /Updated shared UI role/);
  await page.getByRole("button", { name: "Project instructions", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Project instructions", exact: true });
  await dialog.getByRole("textbox", { name: "Repository and task context" }).fill("Only the UI destination workspace.");
  await dialog.getByRole("button", { name: "Save instructions", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  assert.doesNotMatch(await readFile(join(source, "agents", "library-role.md"), "utf8"), /Only the UI destination/);
  console.log("PASS: installed UI imports and previews a shared agent offline, updates the source role and keeps project context private.");
  await stop(); await start();
  dialog = await settings();
  await expect(dialog.getByRole("combobox", { name: "Default agent model", exact: true })).toHaveText(projectModel);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  dialog = await settings("ui-created");
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveText("Use project default");
  await expect(dialog.getByRole("spinbutton", { name: "Max concurrent runs" })).toHaveValue("3");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.goto("http://tauri.localhost/#/ui-target/agents/library-role/prompt");
  await expect(page.getByRole("textbox", { name: "library-role prompt", exact: true })).toContainText("Updated shared UI role.");
  await page.getByRole("button", { name: "Project instructions", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Project instructions", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Repository and task context" })).toHaveValue("Only the UI destination workspace.");
  await screenshot("spool-import-after-restart");
  console.log("PASS: project model, agent settings, shared prompt and private context persist across a complete installed-app restart.");
} catch (error) {
  if (page && !page.isClosed()) {
    await screenshot("spool-ui-failure");
    console.error("UI focus at failure:", await page.evaluate(() => ({
      focused: document.hasFocus(), activeTag: document.activeElement?.tagName,
      activeLabel: document.activeElement?.getAttribute("aria-label"), dialogs: document.querySelectorAll('[role="dialog"]').length,
    })));
  }
  throw error;
} finally {
  await stop();
  await rm(fixture, { recursive: true, force: true });
}
