import { readFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./spool-task-fixture";

test("image picker rejects bad files, changes images, and cancels without writing", async ({ page, projectServer: server, scheduler }) => {
  void scheduler;
  const file = join(server.bohemia, "agents", "engineer.md"), before = await readFile(file, "utf8");
  await page.goto(`${server.url}/bohemia/agents/engineer`);
  await page.getByRole("button", { name: "Agent actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Agent settings", exact: true });
  const select = dialog.getByRole("button", { name: "Upload image", exact: true });
  await expect(select).toHaveCount(1);
  await expect(select.getByRole("img", { name: "Agent image", exact: true })).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await select.click();
  await (await chooser).setFiles([]);
  const input = dialog.locator('input[type="file"]');
  await input.setInputFiles({ name: "bad.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(dialog.getByRole("alert")).toHaveText("Choose a PNG, JPG or WebP image.");
  await input.setInputFiles({ name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  await expect(dialog.getByRole("alert")).toContainText("smaller than 5 MB");
  await input.setInputFiles({ name: "corrupt.png", mimeType: "image/png", buffer: Buffer.from("not a real image") });
  await expect(dialog.getByRole("alert")).toContainText("could not be opened");
  const images = await page.evaluate(() => ["#1b7263", "#dd8844"].map((color) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 300;
    const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, 300, 300);
    return canvas.toDataURL("image/png").split(",")[1];
  }));
  const upload = async (image: string) => {
    await input.setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.getByRole("img", { name: "Agent image", exact: true }).locator("img")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save settings", exact: true })).toBeEnabled();
  };
  await upload(images[0]);
  const preview = dialog.getByRole("img", { name: "Agent image", exact: true }).locator("img");
  const first = await preview.getAttribute("src");
  await upload(images[1]);
  await expect(preview).not.toHaveAttribute("src", first!);
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  expect(await readFile(file, "utf8")).toBe(before);
});
