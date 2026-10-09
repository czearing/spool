"use client";

import dynamic from "../platform/lazy";
import { CalendarDays } from "lucide-react";
import { VisuallyHidden } from "radix-ui";
import type { ReactNode } from "react";
import type { DashboardData } from "../lib/dashboard";
import { formatUsd } from "../lib/currency";
import { useDashboard } from "../hooks/use-dashboard";
import { Card } from "./ui/card";
import { Grid } from "./ui/grid";
import { Stack } from "./ui/stack";
import { Divider } from "./ui/divider";
import { Text } from "./ui/text";
import { Button } from "./ui/button";
import { Dropdown } from "./ui/dropdown";
import { ToolUsagePanel } from "./tool-usage";
import { dashboardRanges, dashboardRangeLabel, isDashboardRange, type DashboardRange } from "../lib/dashboard-range";
import styles from "./dashboard.module.css";

const Graph = dynamic(() => import("./ui/graph").then((module) => module.Graph));
const PieChart = dynamic(() => import("./ui/pie-chart").then((module) => module.PieChart));
export function DashboardView({ data, range = data.range, onRangeChange, pending = false, error, onRetry, tools }: {
  data: DashboardData; range?: DashboardRange; onRangeChange?: (range: DashboardRange) => void;
  pending?: boolean; error?: string; onRetry?: () => void; tools?: ReactNode;
}) {
  return <Stack asChild gap={6}><main className={styles.page}>
    <header><Stack direction="row" justify="space-between" align="center" gap={3} className={styles.heading}>
      <VisuallyHidden.Root asChild><h1>Home</h1></VisuallyHidden.Root>
      <div className={styles.timeline}><Dropdown label="Overview timeline" labelHidden density="compact" icon={<CalendarDays />} value={range}
        options={dashboardRanges} onValueChange={(value) => { if (isDashboardRange(value)) onRangeChange?.(value); }} /></div>
      <Text variant="meta" tone="secondary" role="status">{pending ? "Updating..." : `${data.total.toLocaleString("en-US")} work items`}</Text>
    </Stack><Divider /></header>
    {error && <Stack direction="row" gap={3} align="center" wrap><Text role="alert">{error} Showing the last available snapshot.</Text><Button onClick={onRetry}>Retry</Button></Stack>}
    <Grid gap={4} className={styles.charts} aria-busy={pending}>
      <Card asChild className={styles.panel}><Stack gap={4}><Stack gap={1}>
        <Text asChild variant="heading"><h2>Activity by agent</h2></Text>
        <Text variant="meta" tone="secondary">{dashboardRangeLabel(data.range)} · {data.bucketDays === 1 ? "Daily" : `${data.bucketDays}-day buckets`} · UTC</Text>
      </Stack><div className={styles.graph}><Graph label="Latest task updates" valueLabel="Tasks" data={data.activity} series={data.series} /></div>
        <Text variant="meta" tone="secondary">Each task counts once, on its latest update date.{data.undated > 0 &&
          ` ${data.undated} undated tasks ${data.range === "all" ? "appear in totals only" : "are excluded; choose All time to include them in totals"}.`}</Text>
      </Stack></Card>
      <Card asChild className={styles.panel}><Stack gap={4}><Stack gap={1}>
        <Stack direction="row" justify="space-between" align="center" gap={3} wrap>
          <Text asChild variant="heading"><h2>Cost by agent</h2></Text>
          <Text variant="heading" tabular aria-label="Total recorded cost">{data.usageAvailable ? formatUsd(data.totalCostUsd) : "Unavailable"}</Text>
        </Stack><Text variant="meta" tone="secondary">{dashboardRangeLabel(data.range)} · Spool-calculated USD · UTC</Text>
      </Stack><PieChart label="Cost by agent" data={data.usage} formatValue={formatUsd} />
        <Text variant="meta" tone="secondary">{data.usageAvailable ? "Usage cost, not invoice charges." : "Spool dollar accounting is unavailable. Run usage-sync with an updated Spool."}
          {data.unavailableUsage > 0 && ` Partial history: ${data.unavailableUsage} sources unavailable or incomplete.`}
          {data.excludedUsageIntervals > 0 && ` ${data.excludedUsageIntervals} intervals cross the selected boundary and are excluded.`}</Text>
      </Stack></Card>
    </Grid>
    {tools}
  </main></Stack>;
}
export function Dashboard({ project, initial, version }: { project: string; initial: DashboardData; version: string }) {
  const query = useDashboard(project, initial, version);
  return <DashboardView data={query.data} range={query.range} onRangeChange={query.setRange} pending={query.isFetching}
    error={query.error?.message} onRetry={() => void query.refetch()} tools={<ToolUsagePanel project={project} range={query.range} />} />;
}
