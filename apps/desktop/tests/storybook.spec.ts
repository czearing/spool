import { expect, test } from "@playwright/test";

test("Storybook renders the same single horizontal board", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:6006/iframe.html?id=workroom-board--default&viewMode=story");
  const board = page.getByRole("region", { name: "Work items", exact: true });
  await expect(board.getByRole("heading")).toHaveText(["Backlog", "In progress", "Completed", "Blocked"]);
  await expect(board.getByRole("button")).toHaveCount(6);
  expect(errors).toEqual([]);
});

test("empty Storybook board retains all four drop columns", async ({ page }) => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=workroom-board--empty&viewMode=story");
  const board = page.getByRole("region", { name: "Work items", exact: true });
  await expect(board.getByRole("region")).toHaveCount(4);
  await expect(board.getByRole("button")).toHaveCount(0);
});
