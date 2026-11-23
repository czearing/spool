import { test, expect } from "./project-fixture";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";

function call(id: string, name: string, start: number, duration?: number) {
  const event = (type: string, time: number, data: object) => JSON.stringify({ type, timestamp: new Date(time).toISOString(), data }) + "\n";
  const args = name === "powershell" ? { description: "Run project checks", command: "PRIVATE TOOL INPUT" }
    : name === "view" ? { path: "C:\\project\\src\\example.ts" } : {};
  return event("tool.execution_start", start, { toolCallId: id, toolName: name, toolTitle: `Description of ${id}`, arguments: args })
    + (duration === undefined ? "" : event("tool.execution_complete", start + duration, { toolCallId: id, success: true, result: "PRIVATE TOOL OUTPUT" }));
}
test("canonical session events override display logs, deduplicate sessions and sort correctly", async ({ page, projectServer: server, request }) => {
  const now = Date.now() - 60000, logs = join(server.bohemia, "logs");
  await mkdir(logs);
  for (const [task, status, session] of [["A-1", "completed", "session-1"], ["A-2", "failed", "session-2"]]) {
    const file = join(server.bohemia, "queues", status, `${task}.json`);
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), session_id: session }));
    await mkdir(join(server.root, "sessions", session), { recursive: true });
  }
  await writeFile(join(server.bohemia, "queues", "completed", "duplicate.json"), JSON.stringify({
    id: "duplicate", title: "Same provider session", session_id: "session-1",
  }));
  const file = join(server.root, "sessions", "session-1", "events.jsonl");
  await writeFile(file, call("s1", "powershell", now, 1000) + call("s2", "powershell", now, 2000)
    + call("v1", "view", now, 10) + call("v2", "view", now, 20) + call("v3", "view", now, 30) + call("u1", "unknown", now));
  await writeFile(join(server.root, "sessions", "session-2", "events.jsonl"), call("old", "old-tool", now - 20 * 86400000, 6000));
  await writeFile(join(logs, "A-1.log"), call("s1", "Misleading description from ACP", now, 99999) + '{"type":"tool.execution_start", broken}\n');
  await mkdir(join(server.root, "sessions", "unrelated"), { recursive: true });
  await writeFile(join(server.root, "sessions", "unrelated", "events.jsonl"), call("other", "unrelated-tool", now, 1));
  await page.goto(`${server.url}/bohemia`);
  await expect(page.locator("main dl")).toHaveCount(0);
  const table = page.getByRole("table", { name: "Tool calls", exact: true });
  const names = table.locator("tbody th [title]");
  await expect(names).toHaveText(["Read project\\src\\example.ts", "Run project checks", "Description of u1"]);
  await expect(table.getByRole("columnheader", { name: "Activity", exact: true })).toBeVisible();
  await expect(table.locator("tbody th").nth(1)).toContainText("PowerShell");
  expect((await page.getByRole("region", { name: "Tool calls", exact: true }).boundingBox())!.width).toBeLessThanOrEqual(640);
  await expect(page.getByRole("region", { name: "Tool calls", exact: true })).toHaveCSS("border-top-width", "1px");
  await expect(page.getByRole("region", { name: "Tool calls", exact: true })).toHaveCSS("box-shadow", "none");
  await expect(page.getByRole("region", { name: "Tool calls list", exact: true })).toHaveCSS("outline-style", "none");
  await expect(page.getByRole("region", { name: "Tool calls list", exact: true })).toHaveCSS("border-radius", "0px");
  await expect(table.getByRole("columnheader", { name: "Calls", exact: true })).toHaveAttribute("aria-sort", "descending");
  await expect(table.locator("tbody tr").first().getByRole("cell")).toHaveText(["3", "60 ms"]);
  const toolFilter = page.getByRole("searchbox", { name: "Search tool calls", exact: true });
  await toolFilter.fill("POWERSHELL checks");
  await expect(names).toHaveText(["Run project checks"]);
  await expect(table.locator("tbody tr").first().getByRole("cell")).toHaveText(["2", "3 s"]);
  await toolFilter.fill("no-matching-activity");
  await expect(table).toContainText("No tool calls match your search.");
  await toolFilter.fill("example.ts");
  await expect(names).toHaveText(["Read project\\src\\example.ts"]);
  await toolFilter.fill("");
  await table.getByRole("button", { name: "Total time", exact: true }).click();
  await expect(names).toHaveText(["Read project\\src\\example.ts", "Run project checks", "Description of u1"]);
  await table.getByRole("button", { name: "Total time", exact: true }).click();
  await expect(names).toHaveText(["Run project checks", "Read project\\src\\example.ts", "Description of u1"]);
  await table.getByRole("button", { name: "Calls", exact: true }).click();
  await expect(names).toHaveText(["Description of u1", "Run project checks", "Read project\\src\\example.ts"]);
  const selector = page.getByRole("combobox", { name: "Overview timeline", exact: true });
  await selector.click(); await page.getByRole("option", { name: "Last 30 days", exact: true }).click();
  await expect(names).toContainText(["Description of old"]);
  await selector.click(); await page.getByRole("option", { name: "Last 7 days", exact: true }).click();
  await expect(names).toHaveCount(3);
  await appendFile(file, call("v4", "view", now, 40));
  const data = await (await request.get(`${server.url}/api/projects/bohemia/tool-usage`)).json();
  expect(data).toMatchObject({ recordedSessions: 2, missingSessions: 0, invalidRecords: 0 });
  expect(data.tools.map((row: { name: string }) => row.name)).toEqual(["view", "powershell", "unknown"]);
  expect(data.tools.find((row: { name: string }) => row.name === "view")).toMatchObject({ calls: 4, totalMs: 100 });
  expect(data.tools.find((row: { name: string }) => row.name === "powershell")).toMatchObject({ calls: 2, totalMs: 3000 });
  expect(JSON.stringify(data)).not.toContain("PRIVATE");
  expect(await page.content()).not.toContain("PRIVATE TOOL");
  expect((await request.get(`${server.url}/api/projects/bohemia/tool-usage?range=nope`)).status()).toBe(400);
  expect((await request.get(`${server.url}/api/projects/missing/tool-usage`)).status()).toBe(404);
  await appendFile(file, '{"type":"tool.execution_start", broken}\n');
  await page.reload();
  await expect(page.getByText("Partial data: 1 malformed log records were skipped; totals may be incomplete.", { exact: true })).toBeVisible();
  await expect(names).toHaveText(["Read project\\src\\example.ts", "Run project checks", "Description of u1"]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const name of ["Calls", "Total time"]) {
    const lines = await table.getByRole("button", { name, exact: true }).locator("span").evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      return range.getClientRects().length;
    });
    expect(lines).toBe(1);
  }
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
});
test("tool reads do not block the charts and errors remain explicit and recoverable", async ({ page, projectServer: server }) => {
  let fail = true;
  await page.route("**/tool-usage?range=7d", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (fail) await route.fulfill({ status: 503, json: { error: "Unavailable" } });
    else await route.continue();
  });
  await page.goto(`${server.url}/bohemia`);
  await expect(page.getByRole("figure", { name: "Cost by agent", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Tool calls", exact: true })).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: "Retry tool usage", exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Tool usage is unavailable." })).toBeAttached();
  fail = false;
  await page.getByRole("button", { name: "Retry tool usage", exact: true }).click();
  await expect(page.getByText("No recorded tool calls in this period.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry tool usage", exact: true })).toHaveCount(0);
});

test("unavailable session files are reported and unsafe session references are rejected", async ({ request, projectServer: server }) => {
  const file = join(server.bohemia, "queues", "completed", "A-1.json"), task = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...task, session_id: "not-recorded" }));
  const response = await request.get(`${server.url}/api/projects/bohemia/tool-usage`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ recordedSessions: 0, missingSessions: 1, tools: [] });
  await writeFile(file, JSON.stringify({ ...task, session_id: "../elsewhere" }));
  expect((await request.get(`${server.url}/api/projects/bohemia/tool-usage`)).status()).toBe(503);
});
test("search entered while history is loading is retained and applied when data arrives", async ({ page, projectServer: server }) => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/tool-usage?range=7d", async (route) => {
    await pending;
    await route.fulfill({ json: { range: "7d", undated: 0, invalidRecords: 0, recordedSessions: 1, missingSessions: 0, tools: [
      { name: "powershell", action: "Run package checks", calls: 2, timedCalls: 2, totalMs: 2000 },
      { name: "view", action: "Read package.json", calls: 3, timedCalls: 3, totalMs: 10 },
    ] } });
  });
  await page.goto(`${server.url}/bohemia`);
  const search = page.getByRole("searchbox", { name: "Search tool calls", exact: true });
  await search.fill("powershell checks"); release();
  await expect(search).toHaveValue("powershell checks");
  const table = page.getByRole("table", { name: "Tool calls", exact: true });
  await expect(table.locator("tbody th [title]")).toHaveText(["Run package checks"]);
});
