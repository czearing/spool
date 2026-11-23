import type { SpoolItem } from "./spool-model";

export const dashboardRanges = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "14d", label: "Last 14 days", days: 14 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
  { value: "all", label: "All time", days: null },
] as const;
export type DashboardRange = typeof dashboardRanges[number]["value"];
export const defaultDashboardRange: DashboardRange = "7d";
export const isDashboardRange = (value: unknown): value is DashboardRange => dashboardRanges.some((range) => range.value === value);
export const dashboardRangeLabel = (value: DashboardRange) => dashboardRanges.find((range) => range.value === value)!.label;

export function dashboardWindow(items: readonly SpoolItem[], range: DashboardRange, now: Date) {
  const day = 86_400_000, end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const preset = dashboardRanges.find((entry) => entry.value === range);
  if (!preset || !Number.isFinite(end)) throw new Error("Invalid dashboard timeline.");
  let start = end - ((preset.days ?? 1) - 1) * day;
  if (preset.days === null) for (const item of items) {
    const timestamp = Date.parse(item.updatedAt ?? "");
    if (Number.isFinite(timestamp) && timestamp <= now.getTime()) start = Math.min(start, Math.floor(timestamp / day) * day);
  }
  const days = Math.round((end - start) / day) + 1, bucketDays = Math.ceil(days / 90);
  const format = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC", ...(days > 365 ? { year: "2-digit" } : {}) });
  const labels = Array.from({ length: Math.ceil(days / bucketDays) }, (_, index) => {
    const date = start + index * bucketDays * day, last = Math.min(date + (bucketDays - 1) * day, end);
    return format.format(date) + (bucketDays > 1 && last !== date ? ` - ${format.format(last)}` : "");
  });
  return { start, end: now.getTime(), bucketDays, bucketMs: bucketDays * day, labels };
}
