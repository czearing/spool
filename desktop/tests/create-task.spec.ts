import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./spool-task-fixture";

async function fillTask(page: Page, title = "Create from the live board", agent = "engineer") {
  await page.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New task", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Title", exact: true })).toBeFocused();
  await expect(dialog).not.toContainText(/required|workspace|runner|Assign work/);
  await dialog.getByRole("textbox", { name: "Title", exact: true }).fill(title);
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).click();
  await page.getByRole("option", { name: agent, exact: true }).click();
  await dialog.getByRole("textbox", { name: "Instructions", exact: true }).fill("Follow the instructions. Keep the final character!");
  return dialog;
}
test("Create immediately publishes an actual native task without a runner service or workspace setup", async ({ page, projectServer: server, scheduler }) => {
  void scheduler;
  await page.goto(`${server.url}/bohemia/tasks`); const dialog = await fillTask(page);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  const response = page.waitForResponse((response) => response.url().endsWith("/api/projects/bohemia/tasks") && response.request().method() === "POST");
  const started = performance.now();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  expect((await response).status()).toBe(201);
  await expect(dialog).toBeHidden({ timeout: 2000 }); expect(performance.now() - started).toBeLessThan(2000);
  const files = await readdir(join(server.bohemia, "queues", "incoming")); expect(files).toHaveLength(1);
  const task = JSON.parse(await readFile(join(server.bohemia, "queues", "incoming", files[0]), "utf8"));
  expect(task).toMatchObject({ agent: "engineer", title: "Create from the live board", status: "incoming", workspace: null,
    session_id: null, independent_workspace: false, prompt: "Follow the instructions. Keep the final character!" });
  await expect(page.getByRole("status").filter({ hasText: /^Queued for agent$/ })).toBeVisible();
  const incoming = page.getByRole("region", { name: "Incoming", exact: true });
  await expect(incoming).toContainText(task.title);
  await expect(incoming.getByRole("status")).toHaveCount(0);
  await expect(readFile(join(server.bohemia, "controls", "manual", files[0]), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readdir(join(server.bohemia, "workspaces"))).rejects.toMatchObject({ code: "ENOENT" });
  await server.restart(); await page.reload(); await expect(incoming).toContainText(task.title);
});
test("the actual daemon dispatches an available agent directly to the isolated stub executor", async ({ request, projectServer: server, scheduler }) => {
  void scheduler;
  await rm(join(server.bohemia, "controls", "paused", "engineer"));
  const data = { requestId: randomUUID(), title: "Immediate handoff", agent: "engineer", prompt: "Direct instructions, not repository setup." };
  const response = await request.post(`${server.url}/api/projects/bohemia/tasks`, { headers: { Origin: server.url }, data });
  expect(response.status()).toBe(201);
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(join(server.root, "agent-call.json"), "utf8")); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const failed = await readdir(join(server.bohemia, "queues", "failed"));
      if (failed.includes(`manual-${data.requestId}.json`)) throw new Error(await readFile(join(server.bohemia, "queues", "failed", `manual-${data.requestId}.json`), "utf8"));
      return null;
    }
  }, { timeout: 10000 }).toMatchObject({ prompt: expect.stringContaining(data.prompt), session: expect.any(String), cwd: server.bohemia });
  await expect(readdir(join(server.bohemia, "controls", "manual"))).rejects.toMatchObject({ code: "ENOENT" });
});
test("lost response retries one native task and keeps the draft", async ({ page, projectServer: server, scheduler }) => {
  void scheduler; let first = true;
  await page.route("**/api/projects/bohemia/tasks", async (route) => {
    if (first) { first = false; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await page.goto(`${server.url}/bohemia/tasks`); const dialog = await fillTask(page, "Only once", "reviewer");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Instructions", exact: true })).toHaveText("Follow the instructions. Keep the final character!");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 2000 });
  expect(await readdir(join(server.bohemia, "queues", "incoming"))).toHaveLength(1);
  expect(await readdir(join(server.bohemia, "controls", "ui-submissions"))).toHaveLength(1);
});
test("API publication is synchronous, idempotent and protected from agent deletion", async ({ request, projectServer: server, scheduler }) => {
  void scheduler;
  const url = `${server.url}/api/projects/bohemia/tasks`, headers = { Origin: server.url };
  const data = { requestId: randomUUID(), title: "API task", agent: "reviewer", prompt: "# Review\n\nBe precise." };
  const response = await request.post(url, { headers, data }); expect(response.status()).toBe(201);
  const created = await response.json(); expect(created.state).toBe("accepted");
  expect(await readdir(join(server.bohemia, "queues", "incoming"))).toEqual([`${created.id}.json`]);
  expect((await request.post(url, { headers, data })).status()).toBe(201);
  expect((await request.post(url, { headers, data: { ...data, title: "Changed submission" } })).status()).toBe(409);
  expect((await (await request.get(`${url}?requestId=${data.requestId}`)).json()).state).toBe("accepted");
  expect((await request.delete(`${server.url}/api/projects/bohemia/agents/reviewer`, { headers })).status()).toBe(409);
});
test("stale scheduler health does not pretend the agent received work", async ({ request, projectServer: server }) => {
  const headers = { Origin: server.url }, data = { requestId: randomUUID(), title: "Not delivered", agent: "engineer", prompt: "Do the work." };
  const response = await request.post(`${server.url}/api/projects/bohemia/tasks`, { headers, data });
  expect(response.status()).toBe(503); expect((await response.json()).error).toContain("Spool is offline");
  expect(await readdir(join(server.bohemia, "queues", "incoming"))).toEqual([]);
});
test("API validates origin, project, assignee and content; no workspace input is needed", async ({ request, projectServer: server }) => {
  const url = `${server.url}/api/projects/bohemia/tasks`, headers = { Origin: server.url };
  const data = { requestId: randomUUID(), title: "Title", agent: "engineer", prompt: "Instructions" };
  expect((await request.post(url, { data })).status()).toBe(403);
  expect((await request.post(url, { data, headers: { Origin: "http://foreign.example" } })).status()).toBe(403);
  expect((await request.post(url, { data: "bad", headers })).status()).toBe(415);
  expect((await request.post(url, { data: "{", headers: { ...headers, "Content-Type": "application/json" } })).status()).toBe(400);
  expect((await request.post(`${server.url}/api/projects/missing/tasks`, { data, headers })).status()).toBe(404);
  expect((await request.post(url, { data: { ...data, agent: "missing" }, headers })).status()).toBe(404);
  expect((await request.post(url, { data: { ...data, workspace: server.empty }, headers })).status()).toBe(400);
  expect((await request.post(url, { data: { ...data, prompt: " " }, headers })).status()).toBe(400);
  expect(await readdir(join(server.bohemia, "queues", "incoming"))).toEqual([]);
});
test("empty instructions, cancellation and offline errors preserve the draft", async ({ page, projectServer: server }) => {
  await page.goto(`${server.url}/bohemia/tasks`); const dialog = await fillTask(page, "Draft task");
  await dialog.getByRole("textbox", { name: "Instructions", exact: true }).fill("");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Enter instructions.");
  await dialog.getByRole("textbox", { name: "Instructions", exact: true }).fill("Keep these instructions.");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Spool is offline");
  await expect(dialog.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Draft task");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeFocused();
  expect(await readdir(join(server.bohemia, "queues", "incoming"))).toEqual([]);
});
