import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = (name = "default", theme = "light") =>
  `http://127.0.0.1:6006/iframe.html?id=components-sidebar--${name}&viewMode=story&globals=theme:${theme}`;

for (const theme of ["light", "dark"]) test(`${theme}: sidebar is neutral, accessible navigation with a clear current page`, async ({ page }) => {
  await page.goto(story("default", theme));
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  await expect(nav).toBeVisible();
  const current = nav.getByRole("link", { name: /^Work items/ });
  await expect(current).toHaveAttribute("href", "#work-items");
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect(current).toHaveCSS("font-weight", "600");
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  const color = await current.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(color).toBe(theme === "light" ? "rgb(245, 245, 245)" : "rgb(36, 36, 36)");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(nav.getByRole("menuitem")).toHaveCount(0);
});

test("links retain native keyboard navigation and the consumer owns active state", async ({ page }) => {
  await page.goto(story());
  const inbox = page.getByRole("link", { name: /^Inbox/ });
  const work = page.getByRole("link", { name: /^Work items/ });
  await inbox.focus(); await page.keyboard.press("ArrowDown"); await expect(inbox).toBeFocused();
  await page.keyboard.press("Tab"); await expect(work).toBeFocused();
  await expect(work).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Overview", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(work).not.toHaveAttribute("aria-current");
  await expect(page.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
});

test("collapsible groups use Radix state, associations, and exclude hidden links from Tab order", async ({ page }) => {
  await page.goto(story("collapsed-sections"));
  const trigger = page.getByRole("button", { name: "Favorites", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("link", { name: "Getting started", exact: true })).toBeHidden();
  await trigger.focus(); await page.keyboard.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const contentId = await trigger.getAttribute("aria-controls");
  expect(contentId).toBeTruthy(); await expect(page.locator(`[id="${contentId}"]`)).toBeVisible();
  await page.keyboard.press("Tab"); await expect(page.getByRole("link", { name: "Getting started", exact: true })).toBeFocused();
  await trigger.focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Help & feedback", exact: true })).toBeFocused();
});

test("nested branches preserve independent disclosure state and disabled semantics", async ({ page }) => {
  await page.goto(story("nested"));
  const design = page.getByRole("button", { name: "Design", exact: true });
  const foundations = page.getByRole("button", { name: "Foundations", exact: true });
  await expect(design).toHaveAttribute("aria-expanded", "true");
  await expect(foundations).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Private project", exact: true })).toBeDisabled();
  await foundations.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "Typography", exact: true })).toBeVisible();
  await design.click(); await expect(page.getByRole("link", { name: "Typography", exact: true })).toBeHidden();
  await design.click(); await expect(foundations).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("link", { name: "Private notes", exact: true })).toBeHidden();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("controlled disclosure responds to both external state and its own trigger", async ({ page }) => {
  await page.goto(story("controlled"));
  const trigger = page.getByRole("button", { name: "Favorites", exact: true });
  await page.getByRole("button", { name: "Toggle favorites" }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click(); await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "Guide" })).toBeVisible();
});

test("long navigation scrolls independently with stable header/footer and truncated labels", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 650 });
  await page.goto(story("overflow"));
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  const header = page.getByRole("button", { name: "Switch workspace, Spool" });
  const footer = page.getByRole("link", { name: "Settings", exact: true });
  const headerBefore = await header.boundingBox(), footerBefore = await footer.boundingBox();
  const last = nav.getByRole("link", { name: "A very long document title that should never push the sidebar wider" });
  await last.scrollIntoViewIfNeeded(); await expect(last).toBeInViewport();
  expect(await nav.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect(await header.boundingBox()).toEqual(headerBefore); expect(await footer.boundingBox()).toEqual(footerBefore);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  expect(await nav.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  const label = last.locator("span").nth(1);
  await expect(label).toHaveCSS("text-overflow", "ellipsis");
  expect(await label.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
});

test("workspace switcher composes the existing menu without losing focus", async ({ page }) => {
  await page.goto(story());
  const trigger = page.getByRole("button", { name: "Switch workspace, Spool" });
  await trigger.focus(); await page.keyboard.press("Enter");
  const personal = page.getByRole("menuitemradio", { name: "Personal", exact: true });
  await personal.click();
  await expect(page.getByRole("button", { name: "Switch workspace, Personal" })).toBeFocused();
  await expect(page.getByRole("menu")).toBeHidden();
});

test("small viewports, RTL and forced colors retain usable navigation", async ({ page }) => {
  await page.setViewportSize({ width: 240, height: 640 });
  await page.goto(story("nested"));
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  await expect(nav).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator("html").evaluate((node) => node.setAttribute("dir", "rtl"));
  const sidebar = page.getByRole("complementary");
  await expect(sidebar).toHaveCSS("border-left-width", "1px");
  await expect(sidebar).toHaveCSS("border-right-width", "0px");
  await expect(page.getByRole("button", { name: "Foundations", exact: true }).locator("svg")).toHaveCSS("transform", "matrix(-1, 0, 0, -1, 0, 0)");
  await page.emulateMedia({ forcedColors: "active" });
  await expect(page.getByRole("link", { name: /^Work items/ })).toHaveCSS("outline-style", "solid");
});
