"use client";

import { useMemo, useState, type ReactNode } from "react";
import { History, SquarePen } from "lucide-react";
import { AgentAvatar } from "./agent-avatar";
import type { AgentJobs } from "../lib/agent-jobs";
import { agentConversations } from "../lib/agent-conversations";
import { spoolQueues } from "../lib/spool-model";
import { Sidebar, SidebarAction, SidebarGroup, SidebarItem } from "./ui/sidebar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Stack } from "./ui/stack";
import { StatusDot } from "./ui/status-dot";
import { Text } from "./ui/text";
import { Timestamp } from "./ui/timestamp";
import styles from "./agent-overview.module.css";

const labels = Object.fromEntries(spoolQueues.map(({ id, label }) => [id, label]));
export function AgentOverview({ project, agent, jobs, selected, onSelect, actions, children }: {
  project: string; agent: string; jobs: AgentJobs; selected: string | null;
  onSelect: (id: string | null) => void; actions: ReactNode; children: ReactNode;
}) {
  const [search, setSearch] = useState(""), [open, setOpen] = useState(false);
  const conversations = useMemo(() => agentConversations(jobs), [jobs]);
  const current = conversations.find((job) => job.id === selected);
  const matches = conversations.filter((job) => job.title.toLowerCase().includes(search.trim().toLowerCase()));
  const base = `/${encodeURIComponent(project)}/agents/${encodeURIComponent(agent)}`;
  const select = (id: string | null) => { setOpen(false); onSelect(id); };
  const history = <Sidebar label="Conversations" className={styles.history}
    header={<Stack gap={3}><SidebarGroup><SidebarAction icon={<SquarePen />} onClick={() => select(null)}>New chat</SidebarAction></SidebarGroup>
      <Input label="Search conversations" labelHidden placeholder="Search conversations" type="search" density="compact"
        value={search} onChange={(event) => setSearch(event.target.value)} /></Stack>}>
    <SidebarGroup label="Conversations">
      {matches.map((job) => <SidebarItem key={job.id} href={`${base}?task=${encodeURIComponent(job.id)}`}
        active={job.id === selected} title={job.title} aria-label={job.title} data-work-item-id={job.id}
        onClick={(event) => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); select(job.id);
        }}>
        <Stack gap={1}><span className={styles.title}>{job.title}</span>
          <Stack direction="row" align="center" gap={2}>
            <StatusDot tone={job.status === "failed" ? "danger" : job.status === "in_progress" ? "info" : job.status === "completed" ? "success" : "neutral"}
              pulse={job.status === "in_progress"} />
            <Text variant="meta" tone="muted">{job.archived ? "Archived" : labels[job.status]}</Text>
          </Stack>
        </Stack>
      </SidebarItem>)}
      {!matches.length && <li className={styles.empty}><Text variant="meta" tone="muted">
        {search ? "No matching conversations." : "No conversations yet."}
      </Text></li>}
    </SidebarGroup>
  </Sidebar>;
  return <Stack asChild direction="row" gap={0}><main className={styles.page}>
    <div className={styles.desktop}>{history}</div>
    <Stack gap={0} className={styles.content}>
      <Stack asChild direction="row" align="center" justify="space-between" gap={3}><header className={styles.header}>
        <Stack direction="row" align="center" gap={2} className={styles.identity}>
          <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild>
            <Button className={styles.mobile} aria-label="Open conversations"><History aria-hidden /></Button>
          </PopoverTrigger><PopoverContent label="Conversation history" density="compact" align="start" className={styles.popup}>
            <div className={styles.mobileHistory}>{history}</div>
          </PopoverContent></Popover>
          <AgentAvatar agent={agent} /><Text asChild variant="heading"><h1 className={styles.heading}>{agent}</h1></Text>
        </Stack>
        {actions}
      </header></Stack>
      {current && <Stack direction="row" align="center" justify="space-between" gap={3} className={styles.subject}>
        <Text className={styles.title} title={current.title}>{current.title}</Text>
        <Text variant="meta" tone="muted" className={styles.date}><Timestamp value={current.updatedAt} timeZone="local" /></Text>
      </Stack>}
      <div className={styles.chat}>{children}</div>
    </Stack>
  </main></Stack>;
}
