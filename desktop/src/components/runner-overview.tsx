"use client";

import { Server } from "lucide-react";
import { useStickToBottom } from "use-stick-to-bottom";
import { navigate, useSearchParams } from "../platform/navigation";
import { runnerActivity, type Runner } from "../lib/runners";
import type { RunnerLogs } from "../lib/runner-logs";
import { useRunnerLogs } from "../hooks/use-runner-logs";
import { useRunnerLive } from "./runner-live-provider";
import { ActivityOverview, type ActivityEntry } from "./activity-overview";
import { TerminalOutput } from "./ui/terminal-output";
import { Text } from "./ui/text";
import styles from "./runner-overview.module.css";

const statuses = { queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed",
  interrupted: "Interrupted", filtered: "Filtered" };
export function RunnerOverview({ name, status, logs, selected, onSelect, href, error, loading = false }: {
  name: string; status?: Runner; logs?: RunnerLogs; selected: string | null; onSelect: (id: string | null) => void;
  href: (id: string | null) => string; error?: string; loading?: boolean;
}) {
  const { scrollRef, contentRef } = useStickToBottom({ initial: "instant", resize: "instant" });
  const activity = status ? runnerActivity(status) : "Unknown";
  const entries: ActivityEntry[] = [
    { id: "live", title: "Live", status: activity,
      tone: activity === "Error" ? "danger" : status?.running ? "info" : "neutral",
      active: status?.phase === "scanning", updatedAt: status?.lastRunAt },
    ...(logs?.runs || []).map(run => ({
      id: run.id, title: new Date(run.createdAt).toLocaleString(), status: statuses[run.status],
      updatedAt: run.finishedAt || run.startedAt || run.createdAt, active: run.status === "running",
      tone: run.status === "failed" || run.status === "interrupted" ? "danger" as const :
        run.status === "succeeded" ? "success" as const : run.status === "running" ? "info" as const : "neutral" as const,
    })),
  ];
  return <ActivityOverview title={name} icon={<Server size={20} aria-hidden />} entries={entries}
    selected={selected || "live"} onSelect={id => onSelect(id === "live" ? null : id)}
    href={id => href(id === "live" ? null : id)} historyLabel="Runs" searchLabel="Search runs" emptyLabel="No runs yet.">
    <div className={styles.terminal} ref={scrollRef}>
      <div ref={contentRef} className={styles.output}>
        {error && <Text role="alert">{error}</Text>}
        {!error && status?.error && !selected && <Text role="alert">{status.error}</Text>}
        {!error && (loading ? <Text role="status">Loading logs...</Text> :
          <TerminalOutput key={selected || "live"} aria-label={selected ? "Run output" : "Runner logs"}>
            {logs?.output || "No output yet."}
          </TerminalOutput>)}
        {!error && logs?.truncated && <Text variant="meta" tone="muted">Output truncated.</Text>}
      </div>
    </div>
  </ActivityOverview>;
}
export function RunnerPage({ project, runner }: { project: string; runner: { id: string; name?: string } }) {
  const selected = useSearchParams().get("run"), query = useRunnerLogs(project, runner.id, selected), { status } = useRunnerLive();
  const href = (run: string | null) => `/${encodeURIComponent(project)}/runners/${encodeURIComponent(runner.id)}${run ? `?run=${encodeURIComponent(run)}` : ""}`;
  const current = status.error ? undefined : status.data?.runners.find(row => row.id === runner.id);
  return <RunnerOverview name={current?.name || runner.name || runner.id} status={current} logs={query.error ? undefined : query.data}
    selected={selected} onSelect={run => navigate(href(run))} href={run => `#${href(run)}`}
    loading={query.isPending} error={query.error?.message || status.error?.message} />;
}
