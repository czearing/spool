"use client";

import { VisuallyHidden } from "radix-ui";
import type { ReactNode } from "react";
import { isChartData, isChartSeries, type ChartDatum, type ChartSeries, type ChartTone } from "../../lib/chart-data";
import { Text } from "./text";
import { Stack } from "./stack";
import styles from "./chart.module.css";

export const chartColors: Record<ChartTone, string> = {
  info: "var(--color-info-text)", success: "var(--color-success-text)",
  danger: "var(--color-danger-text)", neutral: "var(--color-text-secondary)",
};
export const chartTooltipStyle = { background: "var(--color-surface)", border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-control)", color: "var(--color-text)", fontSize: "var(--font-size-meta)" };

export function ChartFrame({ label, data, series, empty = false, children, formatValue }: {
  label: string; data: readonly ChartDatum[]; series?: readonly ChartSeries[]; empty?: boolean; children: ReactNode; formatValue?: (value: number) => string;
}) {
  if (!isChartData(data)) throw new Error("Chart values must be finite numbers with text labels.");
  if (series && (!isChartSeries(series) || data.some((point) => series.some(({ key }) => typeof point.values?.[key] !== "number")))) {
    throw new Error("Every chart series requires a unique key and a numeric value in every data point.");
  }
  return <Stack asChild gap={3}><figure className={styles.figure} aria-label={label}>
    <VisuallyHidden.Root asChild><figcaption>{label}</figcaption></VisuallyHidden.Root>
    {empty || !data.length ? <Stack align="center" justify="center" className={styles.empty}><Text tone="muted">No data yet.</Text></Stack> : children}
    <VisuallyHidden.Root asChild><div><table>
      <caption>{label} data</caption><thead><tr><th scope="col">Category</th>
        {series ? series.map(({ key, label: name }) => <th key={key} scope="col">{name}</th>) : <th scope="col">Value</th>}
      </tr></thead>
      <tbody>{data.map((point, index) => <tr key={`${point.label}:${index}`}><th scope="row">{point.label}</th>
        {series ? series.map(({ key }) => <td key={key}>{point.values?.[key]}</td>) : <td>{formatValue ? formatValue(point.value) : point.value}</td>}
      </tr>)}</tbody>
    </table></div></VisuallyHidden.Root>
  </figure></Stack>;
}
