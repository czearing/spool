"use client";

import { memo, useMemo } from "react";
import { Pie, PieChart as RechartsPieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { ChartDatum } from "../../lib/chart-data";
import { ChartFrame, chartColors, chartTooltipStyle } from "./chart";
import { Text } from "./text";
import { Grid } from "./grid";
import { Stack } from "./stack";
import styles from "./chart.module.css";

const formatNumber = (value: number) => value.toLocaleString("en-US");
export const PieChart = memo(function PieChart({ label, data, formatValue = formatNumber }: {
  label: string; data: readonly ChartDatum[]; formatValue?: (value: number) => string;
}) {
  if (data.some((point) => point.value < 0)) throw new Error("Pie chart values cannot be negative.");
  const slices = useMemo(() => data.map((point, index) => ({
    ...point, fill: point.tone ? chartColors[point.tone] : `var(--chart-series-${index % 8 + 1})`,
  })), [data]);
  return <ChartFrame label={label} data={data} formatValue={formatValue} empty={!data.some((point) => point.value > 0)}>
    <ResponsiveContainer width="100%" height={180} minWidth={0} initialDimension={{ width: 300, height: 180 }}>
      <RechartsPieChart accessibilityLayer>
        <Pie data={slices} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="92%"
          stroke="var(--color-surface)" strokeWidth={3} isAnimationActive={false} />
        <Tooltip contentStyle={chartTooltipStyle} formatter={(value) => typeof value === "number" ? formatValue(value) : String(value ?? "")} />
      </RechartsPieChart>
    </ResponsiveContainer>
    <Grid asChild gap={2}><ul className={styles.legend} aria-label={`${label} legend`}>
      {slices.map((point, index) => <Stack asChild direction="row" align="center" gap={2} key={`${point.label}:${index}`}><li>
        <span className={styles.swatch} style={{ backgroundColor: point.fill }} aria-hidden="true" />
        <Text variant="meta" tone="secondary">{point.label}</Text><Text variant="meta" tabular>{formatValue(point.value)}</Text>
      </li></Stack>)}
    </ul></Grid>
  </ChartFrame>;
});
