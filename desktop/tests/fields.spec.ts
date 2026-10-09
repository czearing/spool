import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = (name: string, theme = "light") => `http://127.0.0.1:6006/iframe.html?id=components-${name}&viewMode=story&globals=theme:${theme}`;

for (const theme of ["light", "dark"]) {
  for (const [component, label] of [["input", "Work item"], ["textarea", "Description"]]) {
    test(`${theme}: ${component} has a real label, token styles, and connected error text`, async ({ page }) => {
      await page.goto(story(`${component}--default`, theme));
      const control = page.getByRole("textbox", { name: label, exact: true });
      await page.locator("#storybook-root label").getByText(label, { exact: true }).click();
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS("font-size", "14px");
      await expect(control).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(20, 20, 20)");
      await control.fill("Review the next step.");
      await expect(control).toHaveValue("Review the next step.");
      await expect(control).toHaveAttribute("aria-describedby", /-description$/);
      await page.goto(story(`${component}--invalid`, theme));
      const invalid = page.getByRole("textbox", { name: `${label} (required)`, exact: true });
      await expect(invalid).toHaveAttribute("aria-invalid", "true");
      await expect(invalid).toHaveAttribute("required", "");
      const error = page.getByRole("alert");
      await expect(error).toBeVisible();
      const ids = (await invalid.getAttribute("aria-describedby"))!.split(" ");
      expect(ids).toContain(await error.getAttribute("id"));
      for (const id of ids) expect(await page.locator(`[id="${id}"]`).count()).toBe(1);
      expect((await new AxeBuilder({ page }).include("#storybook-root").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
      await page.goto(story(`${component}--disabled`, theme));
      await expect(page.getByRole("textbox", { name: label })).toBeDisabled();
      await page.goto(story(`${component}--read-only`, theme));
      await expect(page.getByRole("textbox", { name: label })).toHaveAttribute("readonly", "");
    });
  }

  test(`${theme}: Dropdown supports typeahead, disabled choices, selection, and focus return`, async ({ page }) => {
    await page.goto(story("dropdown--default", theme));
    const trigger = page.getByRole("combobox", { name: "Status", exact: true });
    await trigger.focus();
    await page.keyboard.press("Space");
    await expect(page.locator('button[role="combobox"]')).toHaveAttribute("aria-expanded", "true");
    expect((await new AxeBuilder({ page }).include('[role="listbox"]').withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await expect(page.getByRole("option", { name: "Blocked", exact: true })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("c");
    await expect(page.getByRole("option", { name: "Completed", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveText("Completed");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(trigger).toBeFocused();
    expect((await new AxeBuilder({ page }).include("#storybook-root").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await page.goto(story("dropdown--disabled", theme));
    await expect(page.getByRole("combobox", { name: "Status" })).toBeDisabled();
    await page.goto(story("dropdown--invalid", theme));
    await expect(page.getByRole("combobox")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("combobox")).toHaveAttribute("aria-describedby", await page.getByRole("alert").getAttribute("id") ?? "");
  });
}

test("Input controlled value, external descriptions, and forwarded ref stay connected", async ({ page }) => {
  await page.goto(story("input--controlled"));
  await page.getByRole("textbox").fill("Review release");
  await expect(page.getByRole("status")).toHaveText("Review release");
  await expect(page.getByRole("textbox")).toHaveAttribute("aria-describedby", "title-guidance");
  await page.getByRole("button", { name: "Focus title" }).click();
  await expect(page.getByRole("textbox")).toBeFocused();
  await page.goto(story("textarea--controlled"));
  await page.getByRole("textbox").fill("First line\nSecond line");
  await expect(page.getByText("22 / 200", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCSS("resize", "vertical");
});

test("native forms validate and submit Input and Dropdown values", async ({ page }) => {
  await page.goto(story("input--form"));
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByRole("status")).toHaveText("Not saved");
  await expect(page.getByRole("textbox")).toBeFocused();
  await page.getByRole("textbox").fill("Review release");
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved: Review release");
  await page.goto(story("dropdown--form"));
  await page.getByRole("button", { name: "Save status" }).click();
  await expect(page.getByRole("status")).toHaveText("Not saved");
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "In progress", exact: true }).click();
  await page.getByRole("button", { name: "Save status" }).click();
  await expect(page.getByRole("status")).toHaveText("in-progress");
});

test("controlled Dropdown can be selected and cleared without a second state store", async ({ page }) => {
  await page.goto(story("dropdown--controlled"));
  await expect(page.getByRole("combobox")).toHaveText("Backlog");
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Completed", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Selected: completed");
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(page.getByRole("combobox")).toHaveText("Select an option");
});
