import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const theme of ["light", "dark"]) {
  test(`shared runner sidebar shows active navigation and explicit states in ${theme}`, async ({ page }) => {
    const open = (story: string) => page.goto(`http://127.0.0.1:6006/iframe.html?id=runners-sidebar--${story}&viewMode=story&globals=theme:${theme}`);
    await open("default");
    const navigation = page.getByRole("navigation", { name: "Project navigation" });
    await expect(navigation.getByRole("link", { name: "livesite", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(navigation.getByRole("link", { name: "pr-reviewer", exact: true })).toHaveAttribute("href", "/bohemia/runners/pr-reviewer");
    await expect(navigation.getByRole("link", { name: "All runners", exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Runners", exact: true }).click();
    await expect(navigation.getByRole("link", { name: "livesite", exact: true })).toBeHidden();
    await open("loading");
    await expect(page.getByRole("status")).toHaveText("Loading runners...");
    await open("empty");
    await expect(page.getByText("No runners configured", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Create runner", exact: true })).toBeVisible();
    await open("unavailable");
    await expect(page.getByRole("alert")).toHaveText("Runner list unavailable");
    await expect(page.getByRole("link", { name: "livesite", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry runner list", exact: true })).toBeVisible();
  });
}
