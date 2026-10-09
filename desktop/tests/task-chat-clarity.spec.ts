import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function story(page: import("@playwright/test").Page, variant: string, theme = "light") {
  await page.goto(`http://127.0.0.1:6006/iframe.html?id=tasks-conversation--${variant}&viewMode=story&globals=theme:${theme}`);
  await page.getByRole("button", { name: "Open task" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}
for (const theme of ["light", "dark"]) test(`${theme}: queued follow-ups have clear identity, time and status in the shared layout`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  const dialog = await story(page, "queued-follow-up", theme);
  const outgoing = dialog.getByRole("article", { name: "You message" }).filter({ hasText: "Please check keyboard focus" });
  await expect(outgoing).toContainText("Queued"); await expect(outgoing).not.toContainText("Accepted");
  await expect(outgoing.locator("time")).toHaveAttribute("datetime", "2026-09-30T10:01:00Z");
  await expect(dialog.getByText("Follow-ups are queued for the next turn.")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Task instructions|Task log/ })).toHaveCount(0);
  await expect(dialog.getByText("Make every board card accessible by keyboard.", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await expect(dialog.getByRole("textbox", { name: "Message agent" })).toBeVisible();
});
test("finished tasks allow follow-ups while unavailable sessions preserve disabled drafts", async ({ page }) => {
  let dialog = await story(page, "completed");
  await expect(dialog.getByRole("textbox")).toHaveAttribute("aria-disabled", "false");
  dialog = await story(page, "unavailable-session");
  await expect(dialog.getByRole("textbox")).toHaveAttribute("aria-placeholder", "No saved session is available for this conversation.");
  await expect(dialog.getByRole("textbox")).toHaveAttribute("aria-disabled", "true");
  dialog = await story(page, "completed-with-draft");
  await expect(dialog.getByRole("textbox")).toHaveText("My unsent follow-up.");
  await expect(dialog.getByRole("textbox")).toHaveAttribute("aria-disabled", "true");
  await expect(dialog.getByRole("status").filter({ hasText: "No saved session is available" })).toBeVisible();
});
test("waiting and disconnected states never claim the agent is still writing", async ({ page }) => {
  let dialog = await story(page, "waiting-for-reply");
  await expect(dialog.getByRole("textbox")).toHaveAttribute("aria-disabled", "false");
  await expect(dialog.getByRole("textbox")).toHaveAttribute("aria-placeholder", "Message agent...");
  dialog = await story(page, "disconnected");
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveAttribute("aria-disabled", "true");
});
test("quiet copy controls remain keyboard accessible and copy exact Markdown", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const dialog = await story(page, "queued-follow-up");
  const outgoing = dialog.getByRole("article", { name: "You message" }).filter({ hasText: "Please check keyboard focus" });
  const copy = outgoing.getByRole("button", { name: "Copy You message" });
  await copy.focus(); await expect(copy).toBeFocused();
  expect(await copy.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
  await copy.press("Enter");
  await expect(outgoing.getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Please check keyboard focus after closing, too.");
});
for (const variant of ["no-replies", "empty-conversation"]) test(`${variant}: only conversation text and the composer, with no empty-state instructions`, async ({ page }) => {
  const dialog = await story(page, variant);
  await expect(dialog.getByRole("button", { name: /Task instructions|Task log|Earlier messages|Back to latest/ })).toHaveCount(0);
  await expect(dialog.getByText(/No agent replies|No chat messages|Agent working|Enter to send ·|Follow-ups are queued/)).toHaveCount(0);
  await expect(dialog.getByRole("article")).toHaveCount(variant === "no-replies" ? 1 : 0);
  const editor = dialog.getByRole("textbox", { name: "Message agent" });
  await editor.fill("Hello agent."); await editor.press("Enter");
  await expect(editor).toBeEmpty();
  await expect(dialog.getByRole("article", { name: "You message" }).filter({ hasText: "Hello agent." })).toBeVisible();
});
