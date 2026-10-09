import { expect, it } from "vitest";
import { applyCommand } from "./work-items";
import { seedItems } from "./seed";

it("reorders before a target without mutating the source", () => {
  const moved = applyCommand(seedItems, { type: "move", id: "2", status: "backlog", beforeId: "1" });
  expect(moved.map((item) => item.id)).toEqual(["2", "1", "3", "4", "5", "6"]);
  expect(seedItems.map((item) => item.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
  expect(moved[0]).toEqual({ ...seedItems[1], archived: false });
});
it("appends at the end and supports restoring archived items into a specific position", () => {
  const archived = applyCommand(seedItems, { type: "archive", id: "5" });
  const restored = applyCommand(archived, { type: "move", id: "5", status: "backlog", beforeId: "2" });
  expect(restored.map((item) => item.id)).toEqual(["1", "5", "2", "3", "4", "6"]);
  expect(restored[1]).toMatchObject({ archived: false, status: "backlog" });
  expect(applyCommand(seedItems, { type: "move", id: "1", status: "backlog", atEnd: true }).at(-1)?.id).toBe("1");
});
it("rejects missing insertion targets and treats a drop onto itself as unchanged order", () => {
  expect(() => applyCommand(seedItems, { type: "move", id: "1", status: "backlog", beforeId: "missing" })).toThrow("destination");
  expect(applyCommand(seedItems, { type: "move", id: "1", status: "backlog", beforeId: "1" }).map((item) => item.id))
    .toEqual(seedItems.map((item) => item.id));
});
