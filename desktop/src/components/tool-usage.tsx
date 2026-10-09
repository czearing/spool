"use client";

import { useMemo, useState } from "react";
import { useToolUsage } from "../hooks/use-tool-usage";
import { useHydrated } from "../hooks/use-hydrated";
import { dashboardRangeLabel, type DashboardRange } from "../lib/dashboard-range";
import { formatToolTime, toolLabel, type ToolUsage, type ToolUsageRow } from "../lib/tool-usage";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Stack } from "./ui/stack";
import { List, type ListColumn } from "./ui/list";
import { ListCell } from "./ui/list-cell";
import { Text } from "./ui/text";
import styles from "./dashboard.module.css";

const columns: ListColumn<ToolUsageRow>[] = [
  { key: "name", header: "Activity", rowHeader: true, resizable: false, sortValue: (row) => row.action,
    cell: (row) => <ListCell description={toolLabel(row.name)}>
      <span className={styles.toolAction} title={row.action}>{row.action}</span>
    </ListCell> },
  { key: "calls", header: "Calls", align: "end", width: "5.5rem", resizable: false, sortValue: (row) => row.calls,
    cell: (row) => <Text tabular>{row.calls.toLocaleString("en-US")}</Text> },
  { key: "time", header: "Total time", align: "end", width: "6rem", resizable: false, sortValue: (row) => row.totalMs ?? undefined,
    cell: (row) => <Text tabular title={`${row.timedCalls} of ${row.calls} calls have recorded duration`}>{formatToolTime(row.totalMs)}</Text> },
];
const rowKey = (row: ToolUsageRow) => JSON.stringify([row.name, row.action]);
export function ToolUsageView({ range, data, loading = false, error, onRetry }: {
  range: DashboardRange; data?: ToolUsage; loading?: boolean; error?: string; onRetry?: () => void;
}) {
  const [search, setSearch] = useState("");
  const hydrated = useHydrated();
  const tools = useMemo(() => {
    const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return data?.tools.filter((row) => {
      const text = `${row.action} ${row.name} ${toolLabel(row.name)}`.toLowerCase();
      return words.every((word) => text.includes(word));
    }) ?? [];
  }, [data?.tools, search]);
  const untimed = tools.reduce((sum, row) => sum + row.calls - row.timedCalls, 0);
  return <Card asChild className={`${styles.panel} ${styles.tools}`}><Stack asChild gap={4}><section aria-label="Tool calls">
    <Stack gap={2}><Stack direction="row" align="center" justify="space-between" gap={3} wrap>
      <Text asChild variant="heading"><h2>Tool calls</h2></Text>
      <div className={styles.toolSearch}><Input label="Search tool calls" labelHidden type="search" density="compact" disabled={!hydrated}
        placeholder="Search activities or tools..." value={search} onChange={(event) => setSearch(event.target.value)} /></div>
    </Stack>
      <Text variant="meta" tone="secondary">{dashboardRangeLabel(range)} · Grouped by recorded activity · UTC</Text></Stack>
    <List label="Tool calls" items={tools} columns={columns} getRowKey={rowKey} density="compact" appearance="plain"
      defaultSort={{ key: "calls", direction: "desc" }} maxHeight="20rem" virtualize loading={loading && !data}
      loadingMessage="Loading recorded tool calls..." emptyMessage={data?.invalidRecords
        ? "No readable tool calls in this period." : search.trim() ? "No tool calls match your search." : "No recorded tool calls in this period."} error={error} />
    <Stack gap={2}>
    {!!data?.invalidRecords && <Text role="status" variant="meta" tone="secondary">
      Partial data: {data.invalidRecords} malformed log records were skipped; totals may be incomplete.
    </Text>}
    {error ? <Button onClick={onRetry}>Retry tool usage</Button> : <Text variant="meta" tone="secondary">
      Total time sums recorded durations, including overlapping calls.{untimed > 0 && ` ${untimed} calls have no recorded duration.`}
      {!!data?.undated && ` ${data.undated} undated calls ${range === "all" ? "are included" : "are excluded"}.`}
    </Text>}
    {!!data?.missingSessions && <Text variant="meta" tone="secondary">
      {data.recordedSessions} saved sessions read; {data.missingSessions} task session files are unavailable.
    </Text>}
    </Stack>
  </section></Stack></Card>;
}
export function ToolUsagePanel({ project, range }: { project: string; range: DashboardRange }) {
  const query = useToolUsage(project, range);
  return <ToolUsageView range={range} data={query.data} loading={query.isPending} error={query.error?.message} onRetry={() => void query.refetch()} />;
}
