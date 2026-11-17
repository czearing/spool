"use client";

import { useMemo, type ReactNode } from "react";
import { SquarePen } from "lucide-react";
import { AgentAvatar } from "./agent-avatar";
import type { AgentJobs } from "../lib/agent-jobs";
import { agentConversations, agentWorkLabels } from "../lib/agent-conversations";
import { spoolStatuses } from "../lib/spool-model";
import { ActivityOverview, type ActivityEntry } from "./activity-overview";

const labels = Object.fromEntries(spoolStatuses.map(({ id, label }) => [id, label]));
export function AgentOverview({ project, agent, jobs, selected, onSelect, actions, children, historyFeedback, onArchive, archivePending }: {
  project: string; agent: string; jobs: AgentJobs; selected: string | null;
  onSelect: (id: string | null) => void; actions: ReactNode; children: ReactNode; historyFeedback?: ReactNode;
  onArchive?: (id: string, archived: boolean) => void; archivePending?: boolean;
}) {
  const entries: ActivityEntry[] = useMemo(() => agentConversations(jobs).map(job => ({
    id: job.id, title: job.title, updatedAt: job.updatedAt, archived: job.archived,
    status: job.archived ? "Archived" : job.activity ? agentWorkLabels[job.activity] : labels[job.status],
    tone: job.status === "failed" ? "danger" : job.status === "in_progress" ? "info" : job.status === "completed" ? "success" : "neutral",
    active: job.activity === "running" || job.activity === "starting",
  })), [jobs]);
  const base = `/${encodeURIComponent(project)}/agents/${encodeURIComponent(agent)}`;
  return <ActivityOverview title={agent} icon={<AgentAvatar agent={agent} />} entries={entries}
    selected={selected} onSelect={onSelect} href={id => `${base}?task=${encodeURIComponent(id)}`}
    historyLabel="Conversations" searchLabel="Search conversations" emptyLabel="No conversations yet."
    historyAction={{ label: "New chat", icon: <SquarePen />, onSelect: () => onSelect(null) }}
    actions={actions} historyFeedback={historyFeedback} onArchive={onArchive} archivePending={archivePending}>{children}</ActivityOverview>;
}
