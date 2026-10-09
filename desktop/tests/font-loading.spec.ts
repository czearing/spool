import { expect, test } from "@playwright/test";

declare global { interface Window { fontShift: number } }
const fontPattern = "**/fonts/*.woff2";
const boardStory = "http://127.0.0.1:6006/iframe.html?id=workroom-board--default&viewMode=story";
const appBoard = "/bohemia/tasks";

for (const target of [appBoard, boardStory]) {
  test(`${target}: delayed font preserves ${target === appBoard ? "column" : "card"} geometry and keyboard focus`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(fontPattern, async (route) => { await gate; await route.continue(); });
    await page.addInitScript(() => {
      window.fontShift = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if ("value" in entry && typeof entry.value === "number") window.fontShift += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    try {
      await page.goto(target, { waitUntil: "domcontentloaded" });
      const card = target === appBoard ? page.getByRole("list", { name: "Completed items", exact: true })
        : page.getByRole("button", { name: "Plan next release", exact: true });
      await expect(card).toBeVisible();
      await expect.poll(() => page.evaluate(() => [...document.fonts].find((font) => font.family === "Geist Sans")?.status)).toBe("loading");
      const bounds = () => page.locator(target === appBoard ? "#board-items [data-status]" : "button[id^='work-item-']").evaluateAll((nodes) => nodes.map((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      }));
      const before = await bounds();
      await card.focus();
      await page.evaluate(() => { window.fontShift = 0; });
      release();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await expect(card).toBeFocused();
      expect(await bounds()).toEqual(before);
      expect(await page.evaluate(() => window.fontShift)).toBeLessThan(.01);
      const weights = await page.evaluate(async () => Promise.all([400, 500, 600].map(async (weight) => {
        const faces = await document.fonts.load(`${weight} 14px "Geist Sans"`, "José Il1 O0 rn");
        return faces.length === 1 && faces[0].status === "loaded" && faces[0].weight === "400 600";
      })));
      expect(weights).toEqual([true, true, true]);
      const resources = await page.evaluate(() => performance.getEntriesByType("resource")
        .filter((entry) => entry.name.endsWith(".woff2")).map((entry) => entry.name));
      expect(resources).toHaveLength(1);
      expect(new URL(resources[0]).origin).toBe(new URL(page.url()).origin);
    } finally { release(); }
  });
}

test("font failure leaves readable, keyboard-draggable fallback text", async ({ page }) => {
  await page.route(fontPattern, (route) => route.abort());
  await page.goto(boardStory);
  const card = page.getByRole("button", { name: "Set up project", exact: true });
  await expect(card).toBeVisible();
  await expect.poll(() => page.evaluate(() => [...document.fonts].find((font) => font.family === "Geist Sans")?.status)).toBe("error");
  await expect(card.locator("span")).toHaveCSS("font-size", "14px");
  await card.focus();
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("region", { name: "Archive", exact: true })).toHaveAttribute("data-over", "true");
  await page.keyboard.press("Space");
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Archive", exact: true })).toBeFocused();
});

test("cold and warm app loads use only one same-origin font asset", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (request.resourceType() === "font") requests.push(request.url()); });
  const sizes = [];
  for (let load = 0; load < 2; load++) {
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const resources = await page.evaluate(() => performance.getEntriesByType("resource")
      .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming && entry.name.endsWith(".woff2"))
      .map((entry) => ({ bytes: entry.decodedBodySize, transfer: entry.transferSize })));
    expect(resources).toHaveLength(1);
    expect(resources[0].bytes).toBe(47740);
    sizes.push(resources[0].transfer);
  }
  expect(sizes[1]).toBeLessThanOrEqual(sizes[0]);
  expect(new Set(requests).size).toBe(1);
  expect(new URL(requests[0]).origin).toBe(new URL(page.url()).origin);
});
