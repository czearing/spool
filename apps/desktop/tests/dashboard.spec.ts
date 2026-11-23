import { test, expect, costValue, workItemTotal, writeUsage } from "./project-fixture";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";

const usage = (id: string, agent: string, costUsd: number, age = 0) => {
  const time = new Date(Date.now() - age * 86400000 - 1000).toISOString();
  return { id, agent, costUsd, startedAt: time, endedAt: time };
};
test("Home uses dated Spool dollars, ignores lifetime estimates and refreshes without task edits", async ({ page, projectServer: server, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const file = join(server.bohemia, "queues", "completed", "A-1.json"), now = new Date().toISOString();
  await writeFile(file, JSON.stringify({ id: "A-1", title: "Done", agent: "engineer", status: "completed",
    updated_at: now, created_at: now, cost: { total_cost_usd: 9999 }, prompt: "PRIVATE" }));
  const archive = join(server.bohemia, "queues", ".runner-archive"); await mkdir(archive);
  await writeFile(join(archive, "A-1-previous.json"), JSON.stringify({ id: "A-1", agent: "engineer",
    created_at: now, updated_at: now, cost: { total_cost_usd: 9999 } }));
  const records = [usage("older", "engineer", 100, 40), usage("middle", "engineer", 2, 10),
    usage("recent", "engineer", 2.5), usage("review", "reviewer", 0.75)];
  await writeUsage(server.bohemia, records);
  await page.goto(`${server.url}/bohemia`);
  await expect(costValue(page, "engineer")).toHaveText("$2.50");
  await expect(costValue(page, "reviewer")).toHaveText("$0.75");
  await expect(page.getByLabel("Total recorded cost", { exact: true })).toHaveText("$3.25");
  await expect(page.getByText("Usage cost, not invoice charges.", { exact: true })).toBeVisible();
  await expect(page.locator(".recharts-surface")).toHaveCount(2);
  const before = await (await request.get(`${server.url}/api/projects/bohemia/dashboard`)).json();
  expect(before.total).toBe(2); expect(before.totalCostUsd).toBe(3.25);
  expect(JSON.stringify(before)).not.toMatch(/PRIVATE|9999|totalCredits/);
  const selector = page.getByRole("combobox", { name: "Overview timeline", exact: true });
  await selector.click(); await page.getByRole("option", { name: "Last 14 days", exact: true }).click();
  await expect(page.getByLabel("Total recorded cost", { exact: true })).toHaveText("$5.25");
  await selector.click(); await page.getByRole("option", { name: "Last 7 days", exact: true }).click();
  await expect(page.getByLabel("Total recorded cost", { exact: true })).toHaveText("$3.25");
  await request.post(`${server.url}/api/projects/bohemia/tasks/archive`, { data: { status: "completed" }, headers: { Origin: server.url } });
  expect((await (await request.get(`${server.url}/api/projects/bohemia/dashboard`)).json()).totalCostUsd).toBe(3.25);
  await writeUsage(server.bohemia, [...records, usage("next", "engineer", 1.5)]);
  await expect(costValue(page, "engineer")).toHaveText("$4.00", { timeout: 10000 });
  await expect(page.getByLabel("Total recorded cost", { exact: true })).toHaveText("$4.75");
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  expect(errors).toEqual([]);
});
test("dollar charts fit mobile and provide currency-formatted keyboard tooltips", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=home-dashboard--default&viewMode=story");
  await expect(page.locator(".recharts-surface")).toHaveCount(2);
  const graph = page.getByRole("figure", { name: "Latest task updates", exact: true });
  await graph.locator(".recharts-surface").focus(); await page.keyboard.press("ArrowRight");
  await expect(graph.locator(".recharts-tooltip-wrapper")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const pie = page.getByRole("figure", { name: "Cost by agent", exact: true });
  expect((await pie.boundingBox())!.y).toBeGreaterThan((await graph.boundingBox())!.y);
  await expect(pie.getByRole("table").locator("tbody tr")).toHaveCount(3);
  await pie.locator(".recharts-surface").focus(); await page.keyboard.press("ArrowRight");
  await expect(pie.locator(".recharts-tooltip-wrapper")).toBeVisible();
  await expect(pie.locator(".recharts-tooltip-wrapper")).toContainText("$");
});
test("provider usage remains server rendered without JavaScript", async ({ browser, projectServer: server }) => {
  await writeUsage(server.bohemia, [usage("one", "engineer", 1.25)]);
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage(); await page.goto(`${server.url}/bohemia`);
    await expect(costValue(page, "engineer")).toHaveText("$1.25");
    await expect(page.getByLabel("Total recorded cost", { exact: true })).toHaveText("$1.25");
    await expect(workItemTotal(page)).toHaveText("2 work items");
  } finally { await context.close(); }
});
test("missing accounting is explicitly unavailable rather than free spending", async ({ page, projectServer: server }) => {
  await page.goto(`${server.url}/bohemia`);
  await expect(page.getByLabel("Total recorded cost", { exact: true })).toHaveText("Unavailable");
  await expect(page.getByText("Spool dollar accounting is unavailable. Run usage-sync with an updated Spool.", { exact: true })).toBeVisible();
});
test("partial history and boundary-crossing usage stay explicit when switching periods", async ({ page, projectServer: server }) => {
  const now = new Date(), boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 6 * 86400000;
  await writeUsage(server.bohemia, [usage("known", "engineer", 1), {
    id: "boundary", agent: "engineer", costUsd: 10,
    startedAt: new Date(boundary - 3600000).toISOString(), endedAt: new Date(boundary + 3600000).toISOString(),
  }]);
  const file = join(server.bohemia, "usage", "accounting.json"), ledger = JSON.parse(await readFile(file, "utf8"));
  ledger.sessions.fixture.error = "Provider has uncheckpointed activity.";
  await writeFile(file, JSON.stringify(ledger));
  await page.goto(`${server.url}/bohemia`);
  await expect(page.getByLabel("Total recorded cost", { exact: true })).toHaveText("$1.00");
  await expect(page.getByText(/Partial history: 1 sources unavailable or incomplete/)).toBeVisible();
  await expect(page.getByText(/1 intervals cross the selected boundary and are excluded/)).toBeVisible();
  await page.getByRole("combobox", { name: "Overview timeline", exact: true }).click();
  await page.getByRole("option", { name: "Last 14 days", exact: true }).click();
  await expect(page.getByLabel("Total recorded cost", { exact: true })).toHaveText("$11.00");
  await expect(page.getByText(/intervals cross the selected boundary/)).toHaveCount(0);
});
