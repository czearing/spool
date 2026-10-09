import { expect, it } from "vitest";
import { selectBoardItems } from "./board-items";
import { applyCommand } from "./work-items";
import { seedItems } from "./seed";

it("combines title/status search with status filters and excludes archived items", () => {
  expect(selectBoardItems(seedItems, "  BUILD  ", ["in-progress"], "manual").map((item) => item.id)).toEqual(["3"]);
  expect(selectBoardItems(seedItems, "in progress", [], "manual").map((item) => item.id)).toEqual(["3", "4"]);
  expect(selectBoardItems(seedItems, "build", ["completed"], "manual")).toEqual([]);
  expect(selectBoardItems(seedItems.map((item) => ({ ...item, archived: true })), "", [], "manual")).toEqual([]);
});
it("sorts naturally and stably without changing the saved manual order", () => {
  const items = ["Task 10", "Task 2", "Task 2"].map((title, index) => ({ ...seedItems[0], id: String(index), title }));
  expect(selectBoardItems(items, "", [], "title-asc").map((item) => item.id)).toEqual(["1", "2", "0"]);
  expect(selectBoardItems(items, "", [], "title-desc").map((item) => item.id)).toEqual(["0", "1", "2"]);
  expect(selectBoardItems(items, "", [], "manual").map((item) => item.id)).toEqual(["0", "1", "2"]);
  expect(items.map((item) => item.id)).toEqual(["0", "1", "2"]);
});
it("sorts updated times in both directions with stable ties and missing/invalid times last", () => {
  const items = ["2026-10-01T12:00:00Z", undefined, "2026-10-01T10:00:00Z", "bad", "2026-10-01T10:00:00Z"]
    .map((updatedAt, index) => ({ ...seedItems[0], id: String(index), updatedAt }));
  expect(selectBoardItems(items, "", [], "time-desc").map((item) => item.id)).toEqual(["0", "2", "4", "1", "3"]);
  expect(selectBoardItems(items, "", [], "time-asc").map((item) => item.id)).toEqual(["2", "4", "0", "1", "3"]);
  expect(items.map((item) => item.id)).toEqual(["0", "1", "2", "3", "4"]);
});
it("bulk archives only the requested terminal status without changing its timestamps", () => {
  const items = seedItems.map((item) => ({ ...item, updatedAt: "2026-10-01T10:00:00Z" }));
  const result = applyCommand(items, { type: "archive-all", status: "completed" });
  expect(result.filter((item) => item.archived).map((item) => item.id)).toEqual(["5"]);
  expect(result[4].updatedAt).toBe(items[4].updatedAt);
  expect(result[2]).toBe(items[2]);
  expect(items.some((item) => item.archived)).toBe(false);
});
it("searches IDs and assignees and uses the live queue labels when supplied", () => {
  const items = [{ ...seedItems[0], id: "TASK-123", agent: "engineer" }];
  expect(selectBoardItems(items, "task-123", [], "manual")).toEqual(items);
  expect(selectBoardItems(items, "engineer", [], "manual")).toEqual(items);
  const labels = { backlog: "Incoming", "in-progress": "In progress", completed: "Completed", blocked: "Failed" };
  expect(selectBoardItems(items, "incoming", [], "manual", labels)).toEqual(items);
  expect(selectBoardItems(items, "backlog", [], "manual", labels)).toEqual([]);
});
it("creates a trimmed task in its specified column without mutating existing tasks", () => {
  const item = { id: "new", title: "  Follow up  ", status: "blocked" as const };
  const result = applyCommand(seedItems, { type: "create", item });
  expect(result.at(-1)).toEqual({ ...item, title: "Follow up" });
  expect(result[0]).toBe(seedItems[0]);
  expect(seedItems).toHaveLength(6);
  expect(() => applyCommand(seedItems, { type: "create", item: { ...item, title: "  " } })).toThrow("Enter a task title");
  expect(() => applyCommand(seedItems, { type: "create", item: seedItems[0] })).toThrow("already exists");
});
