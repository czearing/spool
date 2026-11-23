import { expect, type Page, type Locator } from "@playwright/test";
export const story = (name: string) => `http://127.0.0.1:6006/iframe.html?id=components-editor--${name}&viewMode=story&globals=theme:light`;
export const editor = (page: Page) => page.getByRole("textbox", { name: "Document", exact: true });
export async function handleFor(page: Page, block: Locator) {
  await block.hover({ position: { x: 10, y: 10 } });
  const handle = page.getByRole("button", { name: /^Move block:/ });
  await expect(handle).toBeVisible(); return handle;
}
export async function pickup(page: Page, block: Locator) {
  const handle = await handleFor(page, block), start = (await handle.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down(); await page.mouse.move(start.x + 12, start.y + 12, { steps: 3 });
}
export async function drag(page: Page, source: Locator, target: Locator, before = false) {
  await pickup(page, source);
  const end = (await target.boundingBox())!;
  await page.mouse.move(end.x + 40, end.y + (before ? 2 : end.height - 2), { steps: 12 });
  await expect(page.locator("[data-drop-indicator]")).toBeVisible(); await page.mouse.up();
}
