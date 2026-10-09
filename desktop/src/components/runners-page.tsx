"use client";

import { useRunnerLive } from "./runner-live-provider";
import dynamic from "../platform/lazy";
import { useMemo, useRef, useState } from "react";
import { repositoryActivity, runnerActivity, type Runner, type RunnerSnapshot } from "../lib/runners";
import { Button } from "./ui/button";
import { List, type ListColumn } from "./ui/list";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { Timestamp } from "./ui/timestamp";
import { StatusDot } from "./ui/status-dot";
import styles from "./runners-page.module.css";
import Link from "../platform/link";

const RunnerDetails = dynamic(() => import("./runner-details").then(module => module.RunnerDetails));
const columns = (onSelect: (id: string, trigger: HTMLButtonElement) => void): ListColumn<Runner>[] => [
  { key: "name", header: "Runner", rowHeader: true, width: "26%", sortValue: row => row.id,
    cell: row => <Button className={styles.runnerButton} title="View runner details" onClick={event => onSelect(row.id, event.currentTarget)}>{row.name || row.id}</Button> },
  { key: "activity", header: "Status", width: "22%", sortValue: runnerActivity,
    cell: row => <Stack direction="row" align="center" gap={2}>
      <StatusDot tone={row.healthy ? row.phase === "scanning" ? "info" : "success" : row.enabled ? "danger" : "neutral"}
        pulse={row.connected && row.phase === "scanning" && !row.stopping} />
      <Text>{runnerActivity(row)}</Text>
    </Stack> },
  { key: "repository", header: "Repository", width: "26%", sortValue: row => row.repository.lastUpdatedAt ? new Date(row.repository.lastUpdatedAt) : undefined,
    cell: row => <Stack gap={1}>
      <Text tone="secondary">{repositoryActivity(row)}</Text>
      {row.repository.mode !== "none" && <Text variant="meta" tone="muted"><Timestamp value={row.repository.lastUpdatedAt} timeZone="local" /></Text>}
    </Stack> },
  { key: "lastRun", header: "Last run (local)", width: "26%", sortValue: row => row.lastRunAt ? new Date(row.lastRunAt) : undefined,
    cell: row => <Stack gap={1}>
      <Timestamp value={row.lastRunAt} timeZone="local" />
      {row.lastRunFailed && <Stack direction="row" align="center" gap={2}>
        <StatusDot tone="danger" /><Text variant="meta" tone="secondary">Last run failed</Text>
      </Stack>}
    </Stack> },
];
const getRowKey = (runner: Runner) => runner.id;
export function RunnersPageView({ data, loading, error, onRetry, project }: {
  data?: RunnerSnapshot; loading?: boolean; error?: string; onRetry: () => void; project?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const fields = useMemo(() => columns((id, button) => { trigger.current = button; setSelectedId(id); }), []);
  const rows = data?.runners ?? [];
  const selected = !error && rows.find(row => row.id === selectedId);
  return <Stack asChild gap={6}><main className={styles.page}>
    <Stack asChild direction="row" align="center" justify="space-between" gap={3} wrap><header>
      <Text asChild variant="heading"><h1 className={styles.title}>Runners</h1></Text>
      <Stack direction="row" align="center" gap={3}>
        <Text variant="meta" tone="secondary" role="status">{error ? "Status unavailable" : loading ? "Checking runners..." :
          `${rows.filter(row => row.connected).length} of ${rows.length} connected`}</Text>
        {project && data?.configured && <Button asChild><Link href={`/${project}/runners/new`}>Create runner</Link></Button>}
      </Stack>
    </header></Stack>
    {error && <Stack direction="row" align="center" justify="space-between" gap={3} wrap>
      <Text>{error}</Text><Button onClick={onRetry} disabled={loading}>Retry</Button>
    </Stack>}
    <List label="Runners" items={rows} columns={fields} getRowKey={getRowKey} appearance="plain"
      minWidth="44rem" defaultSort={{ key: "name", direction: "asc" }} loading={loading}
      loadingMessage="Checking runner connections..." error={error}
      emptyMessage="No runners configured for this project." />
    {data && !error && <Stack gap={1}>
      <Text variant="meta" tone="muted">Select a runner for its script, interval and diagnostics. Repository times reflect confirmed preparation, not scans.</Text>
      <Text variant="meta" tone="muted">Times use your local timezone. Last run includes failed attempts. Checked <Timestamp value={data.checkedAt} timeZone="local" />.</Text>
    </Stack>}
    {selected && <RunnerDetails runner={selected} project={project} onClose={() => setSelectedId(null)}
      onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }} />}
  </main></Stack>;
}
export function RunnersPage({ project }: { project: string }) {
  const query = useRunnerLive();
  return <RunnersPageView project={project} data={query.data} loading={query.isPending && !query.error}
    error={query.error?.message} onRetry={() => void query.refetch()} />;
}
