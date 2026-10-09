import { test, expect } from "@playwright/test";
import { input, submitted, openStory, paste } from "./messaging-helpers";

test.beforeEach(async ({ page }) => { await openStory(page, "chat-input", "acceptance"); await expect(input(page)).toBeVisible(); });
for (const theme of ["light", "dark"]) test(`${theme}: focus uses the existing border without a second frame or layout shift`, async ({ page }) => {
  await openStory(page, "chat-input", "default", theme);
  const surface = input(page).locator("../..");
  const before = await surface.boundingBox();
  const idleColor = await surface.evaluate((node) => getComputedStyle(node).borderColor);
  await input(page).focus();
  const focused = await surface.evaluate((node) => {
    const style = getComputedStyle(node);
    return { border: style.borderColor, width: style.borderWidth, outline: style.outlineStyle, shadow: style.boxShadow };
  });
  expect(focused.border).not.toBe(idleColor);
  expect(focused).toMatchObject({ width: "1px", outline: "none", shadow: "none" });
  expect(await surface.boundingBox()).toEqual(before);
  await page.keyboard.press("Tab");
  const format = page.getByRole("button", { name: "Format text", exact: true });
  await expect(format).toBeFocused();
  expect(await format.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("solid");
  await page.emulateMedia({ forcedColors: "active" }); await input(page).focus();
  expect(await surface.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("solid");
});
test("composer uses the shared primary button styling and an unboxed formatting tool", async ({ page, context }) => {
  const reference = await context.newPage();
  const appearance = (button: import("@playwright/test").Locator) => button.evaluate((node) => {
    const style = getComputedStyle(node);
    return [style.borderRadius, style.backgroundColor, style.borderColor, style.color, style.fontSize, style.fontWeight];
  });
  try {
    const send = page.getByRole("button", { name: "Send message", exact: true });
    await openStory(reference, "button", "primary-disabled");
    expect(await appearance(send)).toEqual(await appearance(reference.getByRole("button", { name: "Button", exact: true })));
    await input(page).fill("Compare the shared controls.");
    await openStory(reference, "button", "primary");
    expect(await appearance(send)).toEqual(await appearance(reference.getByRole("button", { name: "Button", exact: true })));
    await expect(send).toHaveText("Send");
    const format = page.getByRole("button", { name: "Format text", exact: true });
    await expect(format).toHaveText("");
    expect(await format.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.backgroundColor, style.borderColor];
    })).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
    await format.focus(); await page.keyboard.press("ArrowRight");
    await expect(send).toBeFocused();
    await send.click();
    expect((await submitted(page))[0].markdown).toBe("Compare the shared controls.");
  } finally { await reference.close(); }
});
test("send reads the freshest draft, prevents duplicate submits, and clears only on acceptance", async ({ page }) => {
  await input(page).fill("The last character matters!");
  await input(page).press("Enter"); await input(page).press("Enter");
  expect(await submitted(page)).toHaveLength(1);
  await expect(page.getByRole("status").filter({ hasText: "Sending..." })).toBeVisible();
  expect((await submitted(page))[0].markdown).toBe("The last character matters!");
  await expect(input(page)).toHaveText("The last character matters!");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(input(page)).toHaveText("");
  await expect(page.getByText("Sending...", { exact: true })).toHaveCount(0);
  await input(page).focus(); await input(page).press("Control+z");
  await expect(input(page)).toHaveText("");
});
test("a failed send preserves the draft and reuses the submission ID on retry", async ({ page }) => {
  await input(page).fill("Keep this."); await input(page).press("Enter");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your draft is still here");
  await expect(input(page)).toHaveText("Keep this.");
  await page.getByRole("button", { name: "Retry sending message", exact: true }).click();
  const values = await submitted(page); expect(values).toHaveLength(2);
  expect(values[1]).toEqual(values[0]);
});
test("late acceptance cannot erase newer edits; changing a failed draft creates a new ID", async ({ page }) => {
  await input(page).fill("First"); await input(page).press("Enter");
  await input(page).fill("A newer draft");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(input(page)).toHaveText("A newer draft");
  await input(page).press("Enter"); await page.getByRole("button", { name: "Reject", exact: true }).click();
  await input(page).fill("Revised");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry sending message", exact: true })).toHaveCount(0);
  await input(page).press("Enter");
  const values = await submitted(page);
  expect(new Set(values.map((item) => item.id)).size).toBe(3);
});
test("empty and structured drafts both keep their writing area above the action row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  const initial = await input(page).boundingBox(), initialSend = await page.getByRole("button", { name: "Send message", exact: true }).boundingBox();
  expect(initialSend!.y).toBeGreaterThanOrEqual(initial!.y + initial!.height);
  await input(page).focus(); await paste(page, "First paragraph.\n\nSecond paragraph.");
  await expect(input(page).locator("p")).toHaveCount(3);
  const editor = await input(page).boundingBox(), format = await page.getByRole("button", { name: "Format text", exact: true }).boundingBox();
  const send = await page.getByRole("button", { name: "Send message", exact: true }).boundingBox();
  expect(editor).not.toBeNull(); expect(format).not.toBeNull(); expect(send).not.toBeNull();
  expect(format!.y).toBeGreaterThanOrEqual(editor!.y + editor!.height);
  expect(send!.y).toBe(format!.y); expect(editor!.width).toBeGreaterThan(send!.x - format!.x);
  await input(page).fill("Short");
  expect(await input(page).evaluate((node) => node.parentElement!.parentElement!.getBoundingClientRect().height)).toBeLessThanOrEqual(120);
});
test("Shift+Enter edits locally and Enter sends consistently, including lists", async ({ page }) => {
  await input(page).fill("First"); await input(page).press("Shift+Enter"); await page.keyboard.type("Second");
  expect(await submitted(page)).toHaveLength(0);
  await input(page).press("Control+Enter");
  expect((await submitted(page))[0].markdown).toContain("Second");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await input(page).focus(); await paste(page, "- First\n- Second");
  await expect(input(page).locator("li")).toHaveCount(2);
  expect(await submitted(page)).toHaveLength(1);
  await input(page).press("Enter");
  expect((await submitted(page))[1].markdown).toContain("- Second");
});
test("composer stays compact, grows with text and preserves selection when formatting", async ({ page }) => {
  const height = () => input(page).evaluate((node) => node.parentElement!.parentElement!.getBoundingClientRect().height);
  const initial = await height(); expect(initial).toBeGreaterThanOrEqual(108); expect(initial).toBeLessThanOrEqual(120);
  await input(page).fill("Keep this selection"); await input(page).press("Control+a");
  await page.getByRole("button", { name: "Format text", exact: true }).click();
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(input(page).locator("strong")).toHaveText("Keep this selection");
  await expect(input(page)).toBeFocused();
  await input(page).fill("One\nTwo\nThree\nFour");
  expect(await height()).toBeGreaterThan(initial);
  await input(page).fill("Short"); expect(await height()).toBe(initial);
});
test("formatting works after send, and Escape returns to its trigger", async ({ page }) => {
  await input(page).fill("Sent"); await input(page).press("Enter");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(input(page)).toHaveText("");
  await page.getByRole("button", { name: "Format text", exact: true }).click();
  await page.getByRole("button", { name: "Italic", exact: true }).click();
  await page.keyboard.type("Next draft");
  await expect(input(page).locator("em")).toHaveText("Next draft");
  await page.getByRole("button", { name: "Format text", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Format text", exact: true })).toBeFocused();
});
test("composition, repeated Enter and blank content never submit", async ({ page }) => {
  await input(page).press("Enter"); expect(await submitted(page)).toHaveLength(0);
  await input(page).fill("Composing");
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    await input(page).dispatchEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, ...options });
  }
  expect(await submitted(page)).toHaveLength(0);
});
test("Markdown paste preserves code whitespace, formats supported content, and reports unsupported links", async ({ page }) => {
  await input(page).focus();
  await paste(page, "**Important**\n\n```ts\n  first\n\n    second\n```");
  await expect(input(page).locator("strong")).toHaveText("Important");
  await page.getByRole("button", { name: "Export draft" }).click();
  await expect(page.getByLabel("Exported draft")).toContainText("  first\n\n    second");
  await input(page).fill(""); await input(page).focus(); await paste(page, "[Bad](javascript:alert%281%29)");
  await expect(input(page).locator("a")).toHaveCount(0);
  await expect(input(page)).toContainText("Bad");
});
test("undo remains local and unsupported rich HTML is not executed", async ({ page }) => {
  await input(page).focus(); await page.keyboard.type("**Bold** ");
  await expect(input(page).locator("strong")).toHaveText("Bold");
  await input(page).press("Control+z"); expect(await submitted(page)).toHaveLength(0);
  await input(page).evaluate((element) => {
    const data = new DataTransfer(); data.setData("text/html", "<img src=x onerror=alert(1)>");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("alert")).toContainText("Only text can be pasted");
  await expect(input(page)).toHaveAttribute("contenteditable", "true");
  await expect(input(page).locator("img")).toHaveCount(0);
});
