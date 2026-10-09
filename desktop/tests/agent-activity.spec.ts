import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, workItemTotal } from "./project-fixture";

test("two real owned fixture processes show two sessions, then one, then no badges without reloading", async ({ page, projectServer: server }) => {
  const sessions = [randomUUID(), randomUUID()];
  const children = sessions.map((id) => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", "--session-id", id], { stdio: "ignore" }));
  try {
    for (const [index, session_id] of sessions.entries()) {
      await writeFile(join(server.bohemia, "queues", "in_progress", `LIVE-${index}.json`),
        JSON.stringify({ id: `LIVE-${index}`, agent: "engineer", title: "Live fixture", session_id, status: "in_progress" }));
    }
    await page.goto(server.url);
    await expect(page.getByLabel("Agents: 2 active sessions", { exact: true })).toBeVisible({ timeout: 20_000 });
    const accordion = page.getByRole("button", { name: /^Agents/ });
    await expect(accordion).toHaveAttribute("aria-expanded", "false"); await accordion.click();
    await expect(page.getByLabel("engineer: 2 active sessions", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "reviewer", exact: true })).toBeVisible();
    children[0].kill();
    await expect(page.getByLabel("engineer: 1 active session", { exact: true })).toBeVisible({ timeout: 20_000 });
    children[1].kill();
    await expect(page.getByLabel(/engineer: \d+ active/)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByLabel(/Agents: \d+ active/)).toHaveCount(0);
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
});
test("newly configured agents update from disk without a reload", async ({ page, projectServer: server }) => {
  await page.goto(server.url); await expect(workItemTotal(page)).toHaveText("2 work items");
  await writeFile(join(server.bohemia, "agents", "prompt-engineer.md"), "# Prompt engineer\n");
  await rename(join(server.bohemia, "queues", "failed", "A-2.json"), join(server.bohemia, "queues", "completed", "A-2.json"));
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("link", { name: "prompt-engineer", exact: true })).toBeVisible();
});
test("activity failures show an error and hide stale counts rather than pretending agents are still active", async ({ page, projectServer: server }) => {
  let unavailable = false;
  await page.route("**/api/projects/bohemia/live", (route) => unavailable
    ? route.fulfill({ status: 503, json: { error: "Unavailable" } })
    : route.fulfill({ json: { agents: [{ id: "engineer", active: 2 }], successful: 1, boardVersion: "fixture", preparations: [], completed: [] } }));
  await page.goto(server.url);
  await expect(page.getByLabel("Agents: 2 active sessions", { exact: true })).toBeVisible();
  unavailable = true;
  await expect(page.getByRole("alert").filter({ hasText: "Live activity unavailable" })).toBeVisible({ timeout: 8000 });
  await expect(page.getByLabel("Agents: 2 active sessions", { exact: true })).toHaveCount(0);
});
test("Tasks refreshes moved work items while preserving the live read-only board", async ({ page, projectServer: server }) => {
  await page.goto(`${server.url}/bohemia/tasks`);
  await expect(page.getByRole("region", { name: "Failed", exact: true }).locator('[data-work-item-id="A-2"]')).toBeVisible();
  await expect.poll(async () => (await page.request.get(`${server.url}/api/projects/bohemia/live`)).status()).toBe(200);
  await rename(join(server.bohemia, "queues", "failed", "A-2.json"), join(server.bohemia, "queues", "completed", "A-2.json"));
  await expect(page.getByRole("region", { name: "Completed", exact: true }).locator('[data-work-item-id="A-2"]')).toBeVisible({ timeout: 10_000 });
  expect(await readFile(join(server.bohemia, "queues", "completed", "A-2.json"), "utf8")).toContain('"status":"failed"');
});
