export const chartTones = ["info", "success", "danger", "neutral"] as const;
export type ChartTone = typeof chartTones[number];
export type ChartDatum = { label: string; value: number; tone?: ChartTone; values?: Record<string, number> };
export type ChartSeries = { key: string; label: string };
export function isChartSeries(value: unknown): value is ChartSeries[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" &&
    typeof item.key === "string" && /^[a-zA-Z0-9_-]+$/.test(item.key) && typeof item.label === "string") &&
    new Set(value.map((item) => item.key)).size === value.length;
}
export function isChartData(value: unknown): value is ChartDatum[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" &&
    typeof item.label === "string" && typeof item.value === "number" && Number.isFinite(item.value) &&
    (item.tone === undefined || chartTones.includes(item.tone)) &&
    (item.values === undefined || (item.values && typeof item.values === "object" && !Array.isArray(item.values) &&
      Object.values(item.values).every((entry) => typeof entry === "number" && Number.isFinite(entry)))));
}
