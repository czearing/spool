import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const url = (story: string, theme = "light") =>
  `http://127.0.0.1:6006/iframe.html?id=runners-existing-workflows--${story}&viewMode=story&globals=theme:${theme}`;
for (const story of ["reviewer", "livesite", "updater", "spelling"]) test(`${story} uses shared operation blocks and a focused inspector`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url(story));
  await expect(page.locator(".react-flow__node")).toHaveCount(story === "spelling" ? 2 : 3, { timeout: 15000 });
  await expect(page.getByRole("button", { name: "Add step", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Edit ${story === "spelling" ? "Repository" : "Agent"}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("region", { name: /Expected input|Expected output|^Input$|^Output$/ })).toHaveCount(0);
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(640);
  if (story !== "spelling") {
    await expect(dialog.getByRole("textbox", { name: "Task instructions", exact: true })).toHaveValue("{{event.prompt}}");
    await dialog.getByText("Generated event instructions", { exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Task handoff prompt", exact: true })).toHaveValue(/\{\{/);
    await dialog.locator("summary", { hasText: "Agent instructions" }).click();
    if (story === "updater") await expect(dialog).toContainText("Original creator's agent instructions");
    else await expect(dialog.getByRole("textbox", { name: "Agent instructions", exact: true })).toHaveValue(/Never execute real work/);
  } else await expect(dialog.getByRole("combobox", { name: "Operation" })).toContainText("Publish verified fixes");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
});
test("existing runners accept the same Repository block from the shared picker, with selectable operations", async ({ page }) => {
  await page.goto(url("reviewer"));
  const edge = page.locator('.react-flow__edge[data-id="edge-1"]');
  await edge.focus(); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Insert action on connection", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "What happens next?" });
  await expect(picker.getByRole("button", { name: /^Repository/ })).toHaveCount(1);
  await picker.getByRole("button", { name: /^Repository/ }).click();
  await page.getByRole("textbox", { name: "Step name" }).fill("Validate checkout");
  await page.getByRole("combobox", { name: "Operation" }).click();
  await page.getByRole("option", { name: "Check changes", exact: true }).click();
  await page.getByRole("button", { name: "Back to canvas" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Edit Validate checkout", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Operation" })).toContainText("Check changes");
  await page.getByRole("radio", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Delete step", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
});
for (const theme of ["light", "dark"]) test(`integration parameters and task templates save on mobile in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url("reviewer", theme));
  await page.getByRole("button", { name: "Edit Azure DevOps", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Changed revision settle time (seconds)" }).fill("240");
  await page.getByRole("button", { name: "Back to canvas" }).click();
  await page.getByRole("button", { name: "Edit Agent", exact: true }).click();
  await page.getByRole("textbox", { name: "Task instructions", exact: true }).fill("{{event.prompt}}\nInclude a focused reproduction.");
  await page.getByText("Generated event instructions", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Task handoff prompt", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Back to canvas" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Edit Azure DevOps", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Changed revision settle time (seconds)" })).toHaveValue("240");
});
