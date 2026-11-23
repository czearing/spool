import { expect, it } from "vitest";
import { applyCommand, statuses } from "./work-items";
import { seedItems } from "./seed";

it.each(statuses)("moves a work item to %s without mutating other items", (status) => {
  const result = applyCommand(seedItems, { type: "move", id: "1", status });
  expect(result[0].status).toBe(status);
  expect(result[1]).toBe(seedItems[1]);
  expect(seedItems[0].status).toBe("backlog");
});
it.each(statuses)("archives %s work without changing its status or mutating the source", (status) => {
  const source = seedItems.find((item) => item.status === status)!;
  const result = applyCommand(seedItems, { type: "archive", id: source.id });
  expect(result.find((item) => item.id === source.id)).toEqual({ ...source, archived: true });
  expect(source.archived).toBeUndefined();
  for (const item of seedItems.filter((item) => item.id !== source.id)) {
    expect(result.find((updated) => updated.id === item.id)).toBe(item);
  }
  expect(() => applyCommand(result, { type: "archive", id: source.id })).toThrow("This item is already archived.");
});
it.each(statuses)("restores archived work into %s without duplicates or source mutation", (status) => {
  const archived = applyCommand(seedItems, { type: "archive", id: "5" });
  const restored = applyCommand(archived, { type: "move", id: "5", status });
  expect(restored[4]).toEqual({ ...seedItems[4], status, archived: false });
  expect(restored).toHaveLength(seedItems.length);
  expect(restored[0]).toBe(archived[0]);
  expect(archived[4].archived).toBe(true);
  expect(applyCommand(restored, { type: "archive", id: "5" })[4]).toEqual({ ...seedItems[4], status, archived: true });
});
it("rejects missing items", () => {
  expect(() => applyCommand([], { type: "archive", id: "missing" })).toThrow();
});
