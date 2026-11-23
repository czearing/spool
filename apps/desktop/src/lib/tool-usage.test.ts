import { expect, it } from "vitest";
import { formatToolTime, isToolUsage, summarizeToolCalls } from "./tool-usage";

const now = new Date("2026-10-01T12:00:00Z"), timestamp = Date.parse("2026-09-25T00:00:00Z");
it("groups by native tool name and call start time, counting unknown timing without inventing zero", () => {
  const data = summarizeToolCalls([[
    { name: "view", startedAt: timestamp, endedAt: timestamp + 100 },
    { name: "view", startedAt: timestamp, endedAt: timestamp + 900 },
    { name: "shell", startedAt: timestamp },
    { name: "old", startedAt: timestamp - 1, endedAt: timestamp },
    { name: "future", startedAt: now.getTime() + 1 },
    { name: "undated", startedAt: null },
  ]], "7d", now);
  expect(data).toEqual({ range: "7d", undated: 1, invalidRecords: 0, recordedSessions: 1, missingSessions: 0, tools: [
    { name: "view", action: "Description not recorded", calls: 2, timedCalls: 2, totalMs: 1000 },
    { name: "shell", action: "Description not recorded", calls: 1, timedCalls: 0, totalMs: null },
  ] });
  expect(isToolUsage(data)).toBe(true);
});
it("separates activities within a tool while preserving every call and duration", () => {
  const data = summarizeToolCalls([[
    { name: "powershell", action: "Run tests", startedAt: timestamp, endedAt: timestamp + 100 },
    { name: "powershell", action: "Run tests", startedAt: timestamp, endedAt: timestamp + 200 },
    { name: "powershell", action: "Check branch", startedAt: timestamp, endedAt: timestamp + 900 },
    { name: "other", action: "Run tests", startedAt: timestamp, endedAt: timestamp + 400 },
  ]], "7d", now);
  expect(data.tools).toHaveLength(3);
  expect(data.tools[0]).toMatchObject({ name: "powershell", action: "Run tests", calls: 2, totalMs: 300 });
  expect(data.tools.reduce((sum, row) => sum + row.calls, 0)).toBe(4);
  expect(data.tools.reduce((sum, row) => sum + (row.totalMs ?? 0), 0)).toBe(1600);
  expect(isToolUsage(data)).toBe(true);
});
it("includes undated calls only in all time and keeps invalid or future completions untimed", () => {
  const data = summarizeToolCalls([[
    { name: "view", startedAt: null }, { name: "view", startedAt: timestamp, endedAt: timestamp - 1 },
    { name: "view", startedAt: timestamp, endedAt: now.getTime() + 1 }, { name: "zero", startedAt: timestamp, endedAt: timestamp },
  ]], "all", now);
  expect(data.tools[0]).toMatchObject({ calls: 3, totalMs: null, timedCalls: 0 });
  expect(data.tools[1]).toMatchObject({ totalMs: 0, timedCalls: 1 });
  expect(isToolUsage(data)).toBe(true);
  expect(isToolUsage({ ...data, tools: [...data.tools, data.tools[0]] })).toBe(false);
  expect(isToolUsage({ ...data, tools: [{ ...data.tools[0], totalMs: 0 }] })).toBe(false);
  expect(isToolUsage({ ...data, tools: [{ ...data.tools[1], totalMs: Infinity }] })).toBe(false);
});
it("formats comparable time units without treating unknown timing as zero", () => {
  expect([null, 0, 850, 2500, 90000, 5400000].map(formatToolTime)).toEqual(["Not recorded", "0 ms", "850 ms", "2.5 s", "1.5 min", "1.5 h"]);
});
