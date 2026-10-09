import { test, expect } from "@playwright/test";
import { input } from "./messaging-helpers";

type Metrics = { paints: number[]; longTasks: number[]; mutations: number; };
declare global { interface Window { messagingMetrics: Metrics; } }

test.skip(!process.env.MESSAGING_PERFORMANCE_URL, "Run with playwright.messaging-performance.config.ts to measure outside Storybook.");
for (const { count, throttle } of [{ count: 100, throttle: 1 }, { count: 500, throttle: 1 }, { count: 1000, throttle: 1 }, { count: 1000, throttle: 4 }]) {
test(`${count} messages, ${throttle}x CPU: typing stays isolated while a response streams`, async ({ page }) => {
  test.setTimeout(90_000);
  if (throttle > 1) {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
  await page.goto(`${process.env.MESSAGING_PERFORMANCE_URL}?count=${count}`);
  await expect(page.getByRole("article")).toHaveCount(count);
  await input(page).press("Control+End");
  await input(page).press("Enter");
  await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible({ timeout: 15_000 });
  await input(page).fill("Draft context. ".repeat(720));
  await input(page).press("Control+End");
  await page.evaluate(() => {
    window.messagingMetrics = { paints: [], longTasks: [], mutations: 0 };
    const editor = document.querySelector('[role="textbox"]')!;
    editor.addEventListener("keydown", () => {
      const start = performance.now();
      requestAnimationFrame(() => setTimeout(() => { window.messagingMetrics.paints.push(performance.now() - start); }, 0));
    });
    const observer = new MutationObserver((records) => { window.messagingMetrics.mutations += records.length; });
    // The fixed history must remain untouched during editing and streaming.
    for (const article of Array.from(document.querySelectorAll("article")).slice(0, -2)) {
      observer.observe(article, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    new PerformanceObserver((list) => {
      window.messagingMetrics.longTasks.push(...list.getEntries().map((entry) => entry.duration));
    }).observe({ type: "longtask" });
  });
  await page.getByRole("button", { name: "Inspect rendering" }).click();
  const before = JSON.parse(await page.getByLabel("Rendering measurements").innerText());
  await input(page).focus(); await input(page).press("Control+End");
  await page.keyboard.type(" Typing should never compete with a streamed response.", { delay: 20 });
  await expect.poll(() => page.evaluate(() => window.messagingMetrics.paints.length)).toBeGreaterThan(40);
  await page.getByRole("button", { name: "Inspect rendering" }).click();
  const after = JSON.parse(await page.getByLabel("Rendering measurements").innerText());
  const metrics = await page.evaluate(() => window.messagingMetrics);
  const sorted = metrics.paints.toSorted((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * .95)];
  console.log(JSON.stringify({ count, throttle, p95, historyRenders: after.historyRenders - before.historyRenders, longTasks: metrics.longTasks }));
  await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
  await test.info().attach("typing-metrics", { body: JSON.stringify({ count, throttle, p95, ...metrics }), contentType: "application/json" });
  expect(metrics.mutations).toBe(0);
  expect(after.historyRenders - before.historyRenders).toBe(0);
  await expect(input(page)).toContainText("Typing should never compete with a streamed response.");
  // The reference-machine budget is a gate; CPU-throttled runs report degradation separately.
  if (throttle === 1) {
    expect(p95).toBeLessThan(50);
    expect(metrics.longTasks).toEqual([]);
  }
});
}
