"use client";

import { type ReactNode } from "react";
import { runnerActivity, runnerConnection, runnerInterval, repositoryActivity, type Runner } from "../lib/runners";
import { Dialog } from "./ui/dialog";
import { Grid } from "./ui/grid";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { Timestamp } from "./ui/timestamp";
import styles from "./runners-page.module.css";
import Link from "../platform/link";
import { Button } from "./ui/button";

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <Stack gap={1}><Text variant="meta" tone="muted">{label}</Text><Text asChild><div>{children}</div></Text></Stack>;
}
export function RunnerDetails({ runner, project, onClose, onCloseAutoFocus }: {
  runner: Runner; project?: string; onClose: () => void; onCloseAutoFocus: (event: Event) => void;
}) {
  const repository = runner.repository;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }} onCloseAutoFocus={onCloseAutoFocus} title={runner.name || runner.id}
    footer={project && <Button asChild variant="primary"><Link href={`/${project}/runners/${runner.id}`}>Edit runner</Link></Button>}>
    <Stack gap={6}>
      <Detail label="Script"><code className={styles.path}>{runner.script}</code></Detail>
      <Grid columns={2} gap={4}>
        <Detail label="Connection">{runnerConnection(runner)}</Detail>
        <Detail label="Activity">{runnerActivity(runner)}</Detail>
        <Detail label="Scan interval">{runnerInterval(runner.intervalSeconds)}</Detail>
        <Detail label="Configuration">{runner.enabled ? "Enabled" : "Disabled"}</Detail>
        <Detail label="Last attempt"><Timestamp value={runner.lastRunAt} timeZone="local" /></Detail>
        <Detail label="Last successful run"><Timestamp value={runner.lastSuccessAt} timeZone="local" /></Detail>
      </Grid>
      {runner.activeIntervalSeconds !== null && runner.activeIntervalSeconds !== runner.intervalSeconds &&
        <Text variant="meta" tone="secondary">Still running {runnerInterval(runner.activeIntervalSeconds).toLowerCase()}. Saved settings apply after the current run finishes.</Text>}
      <Stack gap={3}>
        <Detail label="Repository updates">{repositoryActivity(runner)}</Detail>
        {repository.mode !== "none" && <>
          <Text variant="meta" tone="secondary">{repository.mode === "workflow" ? "Updated by the workflow's Refresh repository action." :
            "Updated during handoff preparation, not on a timer."}{runner.id === "pr-updater" && " Uses original agent workspaces."}</Text>
          <Grid columns={2} gap={4}>
            <Detail label="Last confirmed update"><Timestamp value={repository.lastUpdatedAt} timeZone="local" /></Detail>
            <Detail label="Last update attempt"><Timestamp value={repository.lastAttemptAt} timeZone="local" /></Detail>
          </Grid>
          {!repository.lastUpdatedAt && <Text variant="meta" tone="muted">No confirmed repository update has been recorded.</Text>}
        </>}
      </Stack>
      {(runner.error || repository.error) && <Stack gap={2} role="alert">
        {runner.error && <Detail label={runner.error === repository.error ? "Last error" : "Last run error"}>{runner.error}</Detail>}
        {repository.error && repository.error !== runner.error && <Detail label="Repository error">{repository.error}</Detail>}
        <Text variant="meta" tone="muted">Full diagnostics remain in the local runner logs.</Text>
      </Stack>}
    </Stack>
  </Dialog>;
}
