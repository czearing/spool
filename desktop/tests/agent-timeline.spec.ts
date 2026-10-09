import { test, expect, costValue, workItemTotal, writeUsage } from "./project-fixture";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";

test("timeline controls every summary and draws every agent with stable series across ranges", async ({ page, projectServer: server, request }) => {
  const today = new Date(), day = 86400000;
  for (const [id, status, agent, age] of [
    ["A-1", "completed", "engineer", 1], ["A-2", "failed", "reviewer", 20], ["A-3", "completed", "engineer", 60],
  ] as const) await writeFile(join(server.bohemia, "queues", status, `${id}.json`), JSON.stringify({
    id, title: id, status, agent, updated_at: new Date(today.getTime() - age * day).toISOString(), cost: { total_cost_usd: 1.25 },
  }));
  await writeFile(join(server.bohemia, "agents", "idle.md"), "# Idle\n");
  await writeUsage(server.bohemia, [1, 20, 60].map((age, index) => {
    const time = new Date(today.getTime() - age * day).toISOString();
    return { id: String(index), agent: index === 1 ? "reviewer" : "engineer", costUsd: 1.25, startedAt: time, endedAt: time };
  }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.url}/bohemia`);
  const selector = page.getByRole("combobox", { name: "Overview timeline", exact: true });
  await expect(selector).toHaveText("Last 7 days");
  const table = page.getByRole("table", { name: "Latest task updates data", exact: true });
  const graph = page.getByRole("figure", { name: "Latest task updates", exact: true });
  const legend = graph.getByRole("list", { name: "Latest task updates legend", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(7);
  await expect(legend.getByRole("listitem")).toHaveText(["engineer"]);
  expect((await (await request.get(`${server.url}/api/projects/bohemia/dashboard`)).json()).range).toBe("7d");
  await expect(graph.locator(".recharts-line-curve")).toHaveCount(3);
  await expect(table.locator("thead th")).toHaveText(["Category", "engineer", "idle", "reviewer"]);
  await expect(costValue(page, "engineer")).toHaveText("$1.25");
  await expect(costValue(page, "reviewer")).toHaveCount(0);
  const styles = () => graph.locator(".recharts-line-curve").evaluateAll((paths) =>
    paths.map((path) => [path.getAttribute("stroke"), path.getAttribute("stroke-dasharray")]));
  const originalStyles = await styles();
  for (const [label, days, successful, failed] of [
    ["Last 14 days", 14, "1", "0"], ["Last 30 days", 30, "1", "1"], ["Last 90 days", 90, "2", "1"],
  ] as const) {
    await selector.click(); await page.getByRole("option", { name: label, exact: true }).click();
    await expect(table.locator("tbody tr")).toHaveCount(days);
    await expect(workItemTotal(page)).toHaveText(`${Number(successful) + Number(failed)} work items`);
    await expect(costValue(page, "engineer")).toHaveText(Number(successful) === 1 ? "$1.25" : "$2.50");
    if (Number(failed)) await expect(costValue(page, "reviewer")).toHaveText("$1.25");
    expect(await styles()).toEqual(originalStyles);
    await expect(legend.getByRole("listitem")).toHaveText(days < 30 ? ["engineer"] : ["engineer", "reviewer"]);
    expect(await legend.locator("line").evaluateAll((lines) => lines.map((line) => [
      line.getAttribute("stroke"), line.getAttribute("stroke-dasharray"),
    ]))).toEqual(days < 30 ? [originalStyles[0]] : [originalStyles[0], originalStyles[2]]);
    await expect(page.getByRole("figure", { name: "Cost by agent", exact: true }).getByRole("list")).toContainText("engineer");
  }
  await selector.focus(); await page.keyboard.press("ArrowDown");
  await page.getByRole("option", { name: "All time", exact: true }).click();
  await expect(costValue(page, "engineer")).toHaveText("$2.50");
  await expect(table.locator("tbody tr")).toHaveCount(61);
  await expect(selector).toBeFocused();
  expect((await request.get(`${server.url}/api/projects/bohemia/dashboard?range=invalid`)).status()).toBe(400);
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("slow or failed range requests retain a labeled snapshot and cannot overwrite a newer selection", async ({ page, projectServer: server }) => {
  let fail = false;
  await page.route("**/dashboard?range=30d", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (fail) await route.fulfill({ status: 503, json: { error: "Unavailable" } });
    else await route.continue();
  });
  await page.goto(`${server.url}/bohemia`);
  const selector = page.getByRole("combobox", { name: "Overview timeline", exact: true });
  const table = page.getByRole("table", { name: "Latest task updates data", exact: true });
  await selector.click(); await page.getByRole("option", { name: "Last 30 days", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Updating..." })).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(7);
  await selector.click(); await page.getByRole("option", { name: "Last 7 days", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(7);
  await page.waitForTimeout(1200);
  await expect(table.locator("tbody tr")).toHaveCount(7);
  fail = true;
  await selector.click(); await page.getByRole("option", { name: "Last 30 days", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Task analytics are unavailable." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  fail = false; await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(30);
});

test("many long agent names retain accessible data without overflowing mobile", async ({ page, projectServer: server }) => {
  for (let index = 0; index < 8; index++) await writeFile(
    join(server.bohemia, "agents", `engineering-performance-reviewer-${index}.md`), "# Reviewer\n");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.url}/bohemia`);
  const table = page.getByRole("table", { name: "Latest task updates data", exact: true });
  await expect(table.locator("thead th")).toHaveCount(12);
  await expect(page.locator(".recharts-line-curve")).toHaveCount(11);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("an all-zero graph has no legend", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=home-dashboard--empty&viewMode=story");
  await expect(page.locator(".recharts-line-curve")).toHaveCount(3);
  await expect(page.getByRole("list", { name: "Latest task updates legend", exact: true })).toHaveCount(0);
});

test("tooltips omit zero agents at each point without changing the plotted values", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=ui-graph--idle-agents&viewMode=story");
  const graph = page.getByRole("figure", { name: "Task activity", exact: true });
  await expect(graph.locator(".recharts-line-curve")).toHaveCount(2);
  await graph.locator(".recharts-surface").focus();
  let positive = false;
  for (let index = 0; index < 3; index++) {
    await page.keyboard.press("ArrowRight");
    await expect(graph.locator(".recharts-tooltip-wrapper")).toBeVisible();
    const rows = graph.locator(".recharts-tooltip-item");
    await expect(rows.filter({ hasText: "Idle" })).toHaveCount(0);
    for (const value of await rows.locator(".recharts-tooltip-item-value").allTextContents()) expect(Number(value)).toBeGreaterThan(0);
    positive ||= await rows.count() > 0;
  }
  expect(positive).toBe(true);
  await expect(graph.getByRole("table").locator("tbody tr").first().getByRole("cell")).toHaveText(["0", "0"]);
});
