import { isChartData, isChartSeries, type ChartDatum, type ChartSeries } from "./chart-data";
import { spoolQueues, type SpoolItem } from "./spool-model";
import { dashboardWindow, defaultDashboardRange, isDashboardRange, type DashboardRange } from "./dashboard-range";
import { summarizeUsage, emptyUsage, type UsageHistory } from "./usage-summary";

export type DashboardData = {
  successful: number; active: number; failed: number; total: number; undated: number;
  activity: ChartDatum[]; statuses: ChartDatum[]; series: ChartSeries[]; range: DashboardRange; bucketDays: number;
  usage: ChartDatum[]; totalCostUsd: number; unavailableUsage: number; excludedUsageIntervals: number; usageAvailable: boolean;
};
export function summarizeTasks(items: readonly SpoolItem[], now = new Date(), range: DashboardRange = defaultDashboardRange,
  agents: readonly string[] = [], usage: UsageHistory = emptyUsage): DashboardData {
  const window = dashboardWindow(items, range, now);
  const names = [...new Set([...agents, ...items.flatMap((item) => item.agent ? [item.agent] : [])])].sort();
  const series: ChartSeries[] = names.map((name) => ({ key: `agent_${name}`, label: name }));
  if (items.some((item) => !item.agent)) series.push({ key: "unassigned", label: "Unassigned" });
  const activity = window.labels.map((label) => ({ label, value: 0, values: Object.fromEntries(series.map(({ key }) => [key, 0])) }));
  const counts = { incoming: 0, in_progress: 0, completed: 0, failed: 0 };
  let undated = 0;
  for (const item of items) {
    const timestamp = Date.parse(item.updatedAt ?? "");
    if (!Number.isFinite(timestamp)) {
      undated++;
      if (range === "all") counts[item.status]++;
      continue;
    }
    if (timestamp < window.start || timestamp > window.end) continue;
    counts[item.status]++;
    const index = Math.floor((timestamp - window.start) / window.bucketMs);
    activity[index].value++;
    activity[index].values[item.agent ? `agent_${item.agent}` : "unassigned"]++;
  }
  const tones = { incoming: "neutral", in_progress: "info", completed: "success", failed: "danger" } as const;
  return { ...summarizeUsage(usage, window.start, window.end, range === "all"), successful: counts.completed, active: counts.in_progress, failed: counts.failed,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0), undated, activity, series, range, bucketDays: window.bucketDays,
    statuses: spoolQueues.map(({ id, label }) => ({ label, value: counts[id], tone: tones[id] })) };
}
export function isDashboardData(value: unknown): value is DashboardData {
  if (!value || typeof value !== "object" || !("series" in value) || !isChartSeries(value.series)) return false;
  const series = value.series;
  return ["successful", "active", "failed", "total", "undated"].every((key) => key in value &&
    typeof Reflect.get(value, key) === "number" && Number.isSafeInteger(Reflect.get(value, key)) && Reflect.get(value, key) >= 0)
    && "range" in value && isDashboardRange(value.range) && "bucketDays" in value && typeof value.bucketDays === "number" &&
    Number.isSafeInteger(value.bucketDays) && value.bucketDays > 0
    && "activity" in value && isChartData(value.activity) && value.activity.length <= 90 &&
    value.activity.every((point) => series.every(({ key }) => typeof point.values?.[key] === "number"))
    && "statuses" in value && isChartData(value.statuses)
    && "usage" in value && isChartData(value.usage) && value.usage.every((point) => point.value >= 0)
    && "totalCostUsd" in value && typeof value.totalCostUsd === "number" && Number.isFinite(value.totalCostUsd) && value.totalCostUsd >= 0
    && "usageAvailable" in value && typeof value.usageAvailable === "boolean"
    && ["unavailableUsage", "excludedUsageIntervals"].every((key) => typeof Reflect.get(value, key) === "number" &&
      Number.isSafeInteger(Reflect.get(value, key)) && Reflect.get(value, key) >= 0);
}
