import { describe, expect, it } from "vitest";
import { parseListLayout } from "../hooks/use-list-preferences";

describe("saved list layouts", () => {
  it("restores only geometry and column ordering", () => {
    expect(parseListLayout(JSON.stringify({ version: 1, widths: { title: 320, status: 180 }, order: ["status", "title"] })))
      .toEqual({ widths: { title: 320, status: 180 }, order: ["status", "title"] });
  });
  it.each([
    "broken", "null", "[]", '{"version":2,"widths":{},"order":[]}',
    '{"version":1,"widths":{"title":-2},"order":[]}',
    '{"version":1,"widths":{"title":"300"},"order":[]}',
    '{"version":1,"widths":{},"order":["title","title"]}',
    '{"version":1,"widths":{},"order":[3]}',
  ])("rejects malformed preferences: %s", (raw) => {
    expect(() => parseListLayout(raw)).toThrow();
  });
});
