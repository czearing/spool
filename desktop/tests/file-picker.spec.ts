import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = (id: string) => `http://127.0.0.1:6006/iframe.html?id=components-filepicker--${id}&viewMode=story`;

test("file picker supports keyboard selection, controlled values and accessible field composition", async ({ page }) => {
  await page.route("**/api/file-picker?kind=file", (route) => route.fulfill({ json: { path: "C:\\Work\\requirements.md" } }));
  await page.goto(story("controlled"));
  const input = page.getByRole("textbox", { name: "File", exact: true });
  const browse = page.getByRole("button", { name: "Browse for File", exact: true });
  await input.focus(); await page.keyboard.press("Tab"); await expect(browse).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("C:\\Work\\requirements.md");
  await expect(page.getByRole("status")).toHaveText("C:\\Work\\requirements.md");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(input).toHaveValue("");
  await input.fill("C:\\Typed"); await expect(page.getByRole("status")).toHaveText("C:\\Typed");
});
test("folder cancel preserves the path and native failures remain visible and recoverable", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/file-picker?kind=folder", (route) => {
    calls++;
    return calls === 1 ? route.fulfill({ json: { path: null } })
      : calls === 2 ? route.fulfill({ status: 500, json: { error: "Picker unavailable. Enter the path instead." } })
      : route.fulfill({ json: { path: "C:\\Selected" } });
  });
  await page.goto(story("folder"));
  const input = page.getByRole("textbox", { name: "Folder", exact: true });
  const browse = page.getByRole("button", { name: "Browse for Folder", exact: true });
  await input.fill("C:\\Original"); await browse.click(); await expect(browse).toBeEnabled();
  await expect(input).toHaveValue("C:\\Original"); await expect(page.getByRole("alert")).toHaveCount(0);
  await browse.click(); await expect(page.getByRole("alert")).toContainText("Picker unavailable");
  await expect(input).toHaveValue("C:\\Original");
  await browse.click(); await expect(input).toHaveValue("C:\\Selected");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(calls).toBe(3);
});
test("pending picker prevents duplicate dialogs and does not overwrite editable input mid-selection", async ({ page }) => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  await page.route("**/api/file-picker?kind=file", async (route) => {
    await pending; await route.fulfill({ json: { path: "C:\\Selected.txt" } });
  });
  try {
    await page.goto(story("default"));
    const input = page.getByRole("textbox", { name: "File", exact: true });
    const browse = page.getByRole("button", { name: "Browse for File", exact: true });
    await browse.click(); await expect(browse).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel choosing File", exact: true })).toBeEnabled();
    await expect(input).toHaveAttribute("readonly", "");
    finish(); await expect(input).toHaveValue("C:\\Selected.txt"); await expect(browse).toBeEnabled();
    await expect(input).not.toHaveAttribute("readonly", "");
  } finally { finish(); }
});
test("page cancellation immediately releases a stuck picker and permits another selection", async ({ page }) => {
  let finish!: () => void, calls = 0;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  await page.route("**/api/file-picker?kind=file", async (route) => {
    if (++calls === 1) await pending;
    await route.fulfill({ json: { path: calls === 1 ? "C:\\Stale.txt" : "C:\\New.txt" } });
  });
  try {
    await page.goto(story("default"));
    const input = page.getByRole("textbox", { name: "File", exact: true });
    const browse = page.getByRole("button", { name: "Browse for File", exact: true });
    await input.fill("C:\\Original"); await browse.click();
    await page.getByRole("button", { name: "Cancel choosing File", exact: true }).click();
    await expect(browse).toBeEnabled({ timeout: 500 });
    await expect(input).toHaveValue("C:\\Original"); await expect(input).not.toHaveAttribute("readonly", "");
    finish(); await browse.click(); await expect(input).toHaveValue("C:\\New.txt");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally { finish(); }
});
test("local picker does not remain paused when the browser reports no internet", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { get: () => false }));
  await page.route("**/api/file-picker?kind=folder", (route) => route.fulfill({ json: { path: null } }));
  await page.goto(story("folder"));
  const request = page.waitForRequest("**/api/file-picker?kind=folder");
  await page.getByRole("button", { name: "Browse for Folder", exact: true }).click();
  await request;
  await expect(page.getByRole("button", { name: "Browse for Folder", exact: true })).toBeEnabled();
});
test("disabled and read-only pickers cannot open the OS dialog", async ({ page }) => {
  for (const id of ["disabled", "read-only"]) {
    await page.goto(story(id));
    await expect(page.getByRole("button", { name: "Browse for File", exact: true })).toBeDisabled();
    await expect(page.getByRole("textbox")).toHaveValue("C:\\Projects\\requirements.md");
  }
});
test("selected path participates in native required validation and FormData", async ({ page }) => {
  await page.route("**/api/file-picker?kind=file", (route) => route.fulfill({ json: { path: "C:\\Notes.md" } }));
  await page.goto(story("form"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Not saved");
  await page.getByRole("button", { name: "Browse for File", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("C:\\Notes.md");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("C:\\Notes.md");
});
test("folder control fits mobile and errors can be cleared by manual entry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(story("unavailable"));
  await page.getByRole("button", { name: "Browse for File", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("textbox").fill("C:\\A very long folder name\\Another folder\\notes.md");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
