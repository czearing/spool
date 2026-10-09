"use client";

import { memo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartDatum, ChartSeries, ChartTone } from "../../lib/chart-data";
import { ChartFrame, chartColors, chartTooltipStyle } from "./chart";
import { Text } from "./text";
import { Stack } from "./stack";
import styles from "./chart.module.css";

const seriesColor = (index: number) => `var(--chart-series-${index % 8 + 1})`;
const seriesDash = (index: number) => ["", "6 3", "2 3", "8 3 2 3"][Math.floor(index / 8) % 4];
export const Graph = memo(function Graph({ label, data, series, tone = "info", valueLabel = "Value" }: {
  label: string; data: readonly ChartDatum[]; series?: readonly ChartSeries[]; tone?: ChartTone; valueLabel?: string;
}) {
  const legend = series?.flatMap((entry, index) => data.some((point) => point.values?.[entry.key] !== 0) ? [{ ...entry, index }] : []);
  return <ChartFrame label={label} data={data} series={series} empty={series?.length === 0}>
    <ResponsiveContainer width="100%" height={260} minWidth={0} initialDimension={{ width: 600, height: 260 }}>
      <LineChart data={data} accessibilityLayer margin={{ top: 16, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" />
        <XAxis dataKey="label" axisLine={false} tickLine={false} minTickGap={28} tickMargin={12}
          tick={{ fill: "var(--color-text-secondary)", fontSize: 12 }} />
        <YAxis allowDecimals={false} axisLine={false} tickLine={false} width={32}
          tick={{ fill: "var(--color-text-secondary)", fontSize: 12 }} />
        <Tooltip formatter={series ? (value) => value === 0 ? null : value : undefined}
          contentStyle={{ ...chartTooltipStyle, maxHeight: 320, overflowY: "auto" }} cursor={{ stroke: "var(--color-border)" }} />
        {series ? series.map((entry, index) => <Line key={entry.key} name={entry.label} type="linear"
          dataKey={(point: ChartDatum) => point.values?.[entry.key]} stroke={seriesColor(index)} strokeDasharray={seriesDash(index)} strokeWidth={2}
          dot={data.length === 1 ? { r: 3 } : false} activeDot={{ r: 4 }} isAnimationActive={false} />)
          : <Line name={valueLabel} type="linear" dataKey="value" stroke={chartColors[tone]} strokeWidth={2}
            dot={data.length === 1 ? { r: 3 } : false} activeDot={{ r: 4 }} isAnimationActive={false} />}
      </LineChart>
    </ResponsiveContainer>
    {!!legend?.length && <Stack asChild direction="row" gap={3} wrap><ul className={styles.seriesLegend} aria-label={`${label} legend`}>
      {legend.map((entry) => <Stack asChild direction="row" align="center" gap={2} key={entry.key}><li>
        <svg width="20" height="8" viewBox="0 0 20 8" aria-hidden="true">
          <line x1="0" y1="4" x2="20" y2="4" stroke={seriesColor(entry.index)} strokeWidth="2" strokeDasharray={seriesDash(entry.index)} />
        </svg><Text variant="meta" tone="secondary">{entry.label}</Text>
      </li></Stack>)}
    </ul></Stack>}
  </ChartFrame>;
});
