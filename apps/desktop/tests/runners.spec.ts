import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./runners-fixture";

test.use({ timezoneId: "America/Los_Angeles" });
test("an open page picks up added, disabled and removed runners from the configuration file", async ({ page, projectServer: server, runnerService }) => {
  test.setTimeout(60000);
  await page.goto(`${server.url}/bohemia/runners`);
  const table = page.getByRole("table", { name: "Runners", exact: true });
  await expect(table.getByRole("rowheader")).toHaveText(["livesite", "pr-updater"]);
  await runnerService.setRunners({ livesite: { enabled: false }, pr_reviewer: { enabled: true } });
  await expect(table.getByRole("rowheader")).toHaveText(["livesite", "pr-reviewer"], { timeout: 1500 });
  await table.getByRole("button", { name: "livesite", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Disabled");
  await page.keyboard.press("Escape");
  await runnerService.setRunners({ pr_updater: { enabled: true } });
  await expect(table.getByRole("rowheader")).toHaveText(["pr-updater"], { timeout: 1500 });
  const response = await page.request.get(`${server.url}/api/projects/bohemia/runners`);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect((await response.json()).runners.map((runner: { id: string }) => runner.id)).toEqual(["pr-updater"]);
});

test("runner page verifies live identity, shows failed run time, sorts and clears stale confirmations", async ({ page, projectServer: server, runnerService }) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${server.url}/bohemia`);
  await page.getByRole("button", { name: "Runners", exact: true }).click();
  await page.getByRole("link", { name: "All runners", exact: true }).click();
  await expect(page).toHaveURL(`${server.url}/bohemia/runners`);
  await expect(page.getByRole("link", { name: "All runners", exact: true })).toHaveAttribute("aria-current", "page");
  const table = page.getByRole("table", { name: "Runners", exact: true });
  const row = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "livesite", exact: true }) });
  await expect(row.getByRole("cell").first()).toHaveText("Error");
  await expect(row.getByRole("cell").last().locator("time")).toHaveAttribute("datetime", runnerService.lastRun);
  await expect(row.getByRole("cell").last().locator("time")).toHaveText("Oct 2, 2026, 5:14 PM");
  await expect(table.getByRole("columnheader", { name: "Last run (local)", exact: true })).toBeVisible();
  await expect(row).toContainText("Last run failed");
  await expect(table.getByRole("row").filter({ hasText: "pr-updater" })).toContainText("Disabled");
  const body = await (await page.request.get(`${server.url}/api/projects/bohemia/runners`)).json();
  expect(JSON.stringify(body)).not.toContain("PRIVATE");
  expect(body.runners.find((entry: { id: string }) => entry.id === "livesite").lastSuccessAt).toBe(runnerService.lastSuccess);
  await expect(table).toHaveAttribute("aria-busy", "false");
  await table.getByRole("button", { name: "Runner", exact: true }).click();
  await expect(table.getByRole("rowheader").first()).toHaveText("pr-updater");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await runnerService.mismatch();
  await expect(row.getByRole("cell").first()).toHaveText("Unknown", { timeout: 1500 });
  await expect(row).not.toContainText("Connected");
  await runnerService.invalidate();
  await expect(page.getByRole("region", { name: "Runners list", exact: true }).getByRole("alert"))
    .toContainText("could not be verified", { timeout: 1500 });
  await expect(table.getByRole("rowheader")).toHaveCount(0);
  await runnerService.setRunners({ livesite: { enabled: true }, pr_updater: { enabled: false } });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(row.getByRole("cell").first()).toHaveText("Unknown");
  expect(errors).toEqual([]);
});

test("runner details show script, configured cadence, verified refresh time and safe errors on desktop and mobile", async ({ page, projectServer: server, runnerService }) => {
  await page.goto(`${server.url}/bohemia/runners`);
  const table = page.getByRole("table", { name: "Runners", exact: true });
  const row = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "livesite", exact: true }) });
  await expect(row).toContainText("Update failed");
  await expect(row.locator(`time[datetime="${runnerService.lastRepositoryUpdate}"]`)).toHaveText("Oct 2, 2026, 1:00 PM");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await row.getByRole("button", { name: "livesite", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "livesite", exact: true });
    await expect(dialog).toContainText("runners\\livesite\\run.mjs");
    await expect(dialog).toContainText("Every 5 min");
    await expect(dialog).toContainText("Still running every 1 min");
    await expect(dialog).toContainText("not on a timer");
    await expect(dialog).toContainText("Dependency installation failed");
    await expect(dialog.locator(`time[datetime="${runnerService.lastRepositoryUpdate}"]`)).toBeVisible();
    expect(await dialog.textContent()).not.toContain("PRIVATE");
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(row.getByRole("button", { name: "livesite", exact: true })).toBeFocused();
  }
  await table.getByRole("button", { name: "pr-updater", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("No confirmed repository update has been recorded");
});

test("unconfigured projects and missing projects have explicit empty or missing states", async ({ page, request, projectServer: server }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.url}/bohemia`);
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Runners", exact: true }).click();
  await page.getByRole("link", { name: "All runners", exact: true }).click();
  await expect(page.getByRole("table", { name: "Runners", exact: true })).toContainText("No runners configured for this project.");
  expect((await request.get(`${server.url}/api/projects/missing/runners`)).status()).toBe(404);
});
