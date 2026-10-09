import { expect, it } from "vitest";
import { isDashboardData, summarizeTasks } from "./dashboard";
import { isChartData } from "./chart-data";
import { dashboardRanges, isDashboardRange } from "./dashboard-range";
import type { SpoolItem } from "./spool-model";

const now = new Date("2026-10-01T20:00:00Z");
const task = (id: string, status: SpoolItem["status"], updatedAt?: string, agent?: string): SpoolItem => ({ id, title: id, status, updatedAt, agent });
it("defaults to the last seven inclusive UTC calendar days", () => {
  const data = summarizeTasks([
    task("1", "completed", "2026-09-25T00:00:00Z"), task("2", "completed", "2026-09-24T23:59:59Z"),
  ], now);
  expect(data.range).toBe("7d");
  expect(data.activity).toHaveLength(7);
  expect(data.successful).toBe(1);
});
it("counts each agent's latest updates in UTC, with the same window for metrics and status", () => {
  const data = summarizeTasks([
    task("1", "completed", "2026-10-01T00:30:00Z", "engineer"), task("2", "failed", "2026-09-30T23:30:00-01:00", "reviewer"),
    task("3", "in_progress", "2026-09-18T00:00:00Z", "engineer"), task("4", "incoming", "2026-09-17T23:59:59Z"),
    task("5", "completed"), task("6", "failed", "invalid"), task("7", "incoming", "2026-10-02T00:00:00Z"),
  ], now, "14d", ["idle", "engineer", "reviewer"]);
  expect(data).toMatchObject({ successful: 1, active: 1, failed: 1, total: 3, undated: 2, range: "14d", bucketDays: 1 });
  expect(data.activity).toHaveLength(14);
  expect(data.activity[0]).toMatchObject({ label: "Sep 18", value: 1, values: { agent_engineer: 1, agent_idle: 0, agent_reviewer: 0 } });
  expect(data.activity.at(-1)).toMatchObject({ label: "Oct 1", value: 2, values: { agent_engineer: 1, agent_reviewer: 1 } });
  expect(data.activity.reduce((sum, point) => sum + point.value, 0)).toBe(3);
  expect(data.statuses.map((point) => point.value)).toEqual([0, 1, 1, 1]);
  expect(isDashboardData(data)).toBe(true);
});
it("keeps agent identities and zero-filled buckets stable across every preset", () => {
  const items = [task("1", "completed", "2026-09-12T00:00:00Z", "engineer"), task("2", "completed", "2026-10-01T00:00:00Z", "reviewer")];
  const base = summarizeTasks(items, now);
  for (const range of dashboardRanges) {
    const data = summarizeTasks(items, now, range.value);
    expect(data.series).toEqual(base.series);
    expect(data.activity.length).toBeLessThanOrEqual(90);
    if (range.days) expect(data.activity).toHaveLength(range.days);
    for (const point of data.activity) expect(Object.values(point.values ?? {}).reduce((sum, value) => sum + value, 0)).toBe(point.value);
  }
  expect(summarizeTasks(items, now, "7d").total).toBe(1);
  expect(summarizeTasks(items, now, "30d").total).toBe(2);
});
it("separates unassigned tasks from an agent named unassigned and includes undated totals only for all-time", () => {
  const items = [task("1", "completed", "2026-10-01", "unassigned"), task("2", "failed", "2026-10-01"), task("3", "completed")];
  const data = summarizeTasks(items, now, "all");
  expect(data.series).toEqual([{ key: "agent_unassigned", label: "unassigned" }, { key: "unassigned", label: "Unassigned" }]);
  expect(data.total).toBe(3);
  expect(data.activity[0].values).toEqual({ agent_unassigned: 1, unassigned: 1 });
  expect(summarizeTasks(items, now, "7d").total).toBe(2);
});
it("bounds all-time output without losing counts, including leap days and year boundaries", () => {
  const items = [task("1", "completed", "2020-02-29T23:00:00Z", "engineer"), task("2", "completed", "2026-10-01T12:00:00Z", "engineer")];
  const data = summarizeTasks(items, now, "all");
  expect(data.bucketDays).toBeGreaterThan(1);
  expect(data.activity.length).toBeLessThanOrEqual(90);
  expect(data.activity[0].value).toBe(1);
  expect(data.activity.at(-1)?.value).toBe(1);
  expect(data.activity.reduce((sum, point) => sum + point.value, 0)).toBe(2);
});
it("keeps empty projects truthful and rejects invalid or incomplete series payloads", () => {
  const data = summarizeTasks([], now, "14d", ["idle"]);
  expect(data.total).toBe(0);
  expect(data.activity.every((point) => point.value === 0 && point.values?.agent_idle === 0)).toBe(true);
  expect(data.statuses.every((point) => point.value === 0)).toBe(true);
  expect(isChartData([{ label: "bad", value: Infinity }])).toBe(false);
  expect(isChartData([{ label: "bad", value: 1, values: { idle: NaN } }])).toBe(false);
  expect(isDashboardData({ ...data, series: [...data.series, ...data.series] })).toBe(false);
  expect(isDashboardData({ ...data, activity: [{ label: "day", value: 1, values: {} }] })).toBe(false);
  expect(isDashboardData({ ...data, total: -1 })).toBe(false);
  expect(isDashboardRange("forever")).toBe(false);
});
