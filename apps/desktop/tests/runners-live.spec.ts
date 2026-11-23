import { test, expect } from "./runners-fixture";

test("scan transitions stream within 1.5s without polling, loading flicker or replacing the row", async ({ page, projectServer: server, runnerService }) => {
  const requests: string[] = [], glitches: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/projects/bohemia/runners") {
      requests.push(request.headers().accept ?? "");
    }
  });
  await page.goto(`${server.url}/bohemia/runners`);
  const table = page.getByRole("table", { name: "Runners", exact: true });
  const row = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "livesite", exact: true }) });
  await expect(row.getByRole("cell").first()).toHaveText("Error");
  await page.exposeFunction("runnerGlitch", (message: string) => glitches.push(message));
  await table.evaluate(element => {
    const original = element.querySelector("tbody tr");
    new MutationObserver(() => {
      if (element.getAttribute("aria-busy") !== "false" || !original?.isConnected ||
          element.closest("main")?.textContent?.includes("Checking runner")) {
        if ("runnerGlitch" in window && typeof window.runnerGlitch === "function") void window.runnerGlitch("Rows entered a loading state.");
      }
    }).observe(element.closest("main")!, { childList: true, subtree: true, attributes: true });
  });
  for (const phase of ["scanning", "ready", "scanning", "ready"] as const) {
    const start = Date.now();
    await runnerService.setPhase(phase);
    await expect(row.getByRole("cell").first()).toHaveText(phase === "scanning" ? "Running" : "Idle", { timeout: 1500 });
    expect(Date.now() - start).toBeLessThan(1500);
  }
  await row.getByRole("button", { name: "livesite", exact: true }).click();
  await runnerService.setPhase("scanning");
  await expect(page.getByRole("dialog")).toContainText("Running", { timeout: 1500 });
  expect(requests).toEqual(["text/event-stream"]);
  expect(glitches).toEqual([]);
});

test("a failed stream reconnects automatically and receives a fresh snapshot", async ({ page, projectServer: server, runnerService }) => {
  await page.goto(`${server.url}/bohemia/runners`);
  const table = page.getByRole("table", { name: "Runners", exact: true });
  await expect(table.getByRole("rowheader")).toHaveCount(2);
  await runnerService.invalidate();
  await expect(table.getByRole("rowheader")).toHaveCount(0);
  await runnerService.setRunners({ livesite: { enabled: true } });
  await expect(table.getByRole("rowheader")).toHaveText(["livesite"], { timeout: 5000 });
  await runnerService.setPhase("scanning");
  await expect(table.getByRole("row").filter({ hasText: "livesite" }).getByRole("cell").first())
    .toHaveText("Running", { timeout: 1500 });
});

test("manual retry never restores stale rows before a fresh snapshot", async ({ page, projectServer: server, runnerService }) => {
  await page.goto(`${server.url}/bohemia/runners`);
  const table = page.getByRole("table", { name: "Runners", exact: true });
  await expect(table.getByRole("rowheader")).toHaveCount(2);
  await runnerService.invalidate();
  await expect(table.getByRole("rowheader")).toHaveCount(0);
  const stale: boolean[] = [];
  await page.exposeFunction("staleRunnerRows", () => stale.push(true));
  await table.evaluate(element => {
    new MutationObserver(() => {
      if (element.querySelector("th[scope=row]") && "staleRunnerRows" in window && typeof window.staleRunnerRows === "function") {
        void window.staleRunnerRows();
      }
    }).observe(element, { childList: true, subtree: true });
  });
  const failed = page.waitForEvent("requestfinished", request => new URL(request.url()).pathname.endsWith("/runners"));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await failed;
  await expect(table.getByRole("rowheader")).toHaveCount(0);
  expect(stale).toEqual([]);
});
