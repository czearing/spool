import type { ChartDatum } from "./chart-data";

export type UsageRecord = { startedAt: string; endedAt: string; costUsd: number; agent: string | null };
export type UsageHistory = { records: readonly UsageRecord[]; unavailableSources: number; available: boolean };
export const emptyUsage: UsageHistory = { records: [], unavailableSources: 0, available: false };

export function summarizeUsage(history: UsageHistory, start: number, end: number, all: boolean) {
  const totals = new Map<string, number>();
  let excludedUsageIntervals = 0;
  for (const record of history.records) {
    const from = Date.parse(record.startedAt), to = Date.parse(record.endedAt);
    if (from > end || !all && to < start) continue;
    if (to > end || !all && from < start) {
      if (record.costUsd > 0) excludedUsageIntervals++;
      continue;
    }
    const agent = record.agent ?? "Unattributed";
    totals.set(agent, (totals.get(agent) ?? 0) + record.costUsd);
  }
  const totalCostUsd = [...totals.values()].reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(totalCostUsd) || totalCostUsd > Number.MAX_SAFE_INTEGER) throw new Error("Recorded dollar totals exceed the supported range.");
  const usage: ChartDatum[] = [...totals].filter(([, value]) => value > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([label, value]) => ({ label, value }));
  return { usage, totalCostUsd, unavailableUsage: history.unavailableSources, excludedUsageIntervals,
    usageAvailable: history.available && (history.records.length > 0 || history.unavailableSources === 0) };
}
