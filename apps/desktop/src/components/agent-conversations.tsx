"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { navigate, useSearchParams } from "../platform/navigation";
import dynamic from "../platform/lazy";
import type { AgentJob, AgentJobs } from "../lib/agent-jobs";
import type { TaskConversation } from "../lib/task-conversation";
import { agentConversations, updateConversationArchive } from "../lib/agent-conversations";
import { useConversationArchive } from "../hooks/use-conversation-archive";
import { useAgentJobs } from "../hooks/use-agent-jobs";
import { AgentOverview } from "./agent-overview";
import { AgentActions } from "./agent-actions";
import TaskChat from "./task-chat";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { Button } from "./ui/button";
import styles from "./agent-overview.module.css";
import { ContentPlaceholder } from "./ui/content-placeholder";

const loading = () => <ContentPlaceholder label="Conversation" />;
const NewConversation = dynamic(() => import("./agent-new-conversation"), { ssr: false, loading });
const emptyJobs: AgentJobs = { current: [], history: [] };

export function AgentConversations({ project, agent, jobs: initialJobs }: { project: string; agent: string; jobs?: AgentJobs }) {
  const query = useAgentJobs(project, agent, initialJobs), jobs = query.data ?? emptyJobs;
  const archive = useConversationArchive(project, agent);
  const selected = useSearchParams().get("task"), [created, setCreated] = useState<AgentJob[]>([]);
  const cached = useQuery({
    queryKey: ["task-conversation", project, selected ?? ""], enabled: false,
    select: (conversation: TaskConversation) => conversation.task,
  });
  const visible = useMemo(() => {
    const displayed = archive.isPending && archive.variables
      ? updateConversationArchive(jobs, archive.variables.id, archive.variables.archived) : jobs;
    if (!created.length) return displayed;
    const ids = new Set(agentConversations(jobs).map((job) => job.id));
    return { current: [...created.filter((job) => !ids.has(job.id)), ...displayed.current], history: displayed.history };
  }, [jobs, created, archive.isPending, archive.variables]);
  const conversations = useMemo(() => agentConversations(visible), [visible]);
  const current = conversations.find((job) => job.id === selected)
    ?? (!query.data && cached.data?.id === selected && cached.data.agent === agent ? cached.data : undefined);
  const select = (id: string | null) => {
    if (selected !== id) navigate(`/${encodeURIComponent(project)}/agents/${encodeURIComponent(agent)}${id ? `?task=${encodeURIComponent(id)}` : ""}`);
  };
  const historyFeedback = query.error ? <Stack gap={2}>
    <Text role="alert" variant="meta">{query.error.message}</Text>
    <Button onClick={() => void query.refetch()}>Retry conversations</Button>
  </Stack> : !query.data ? <ContentPlaceholder label="Conversation list" compact /> : undefined;
  return <AgentOverview project={project} agent={agent} jobs={visible} selected={selected} onSelect={select}
    historyFeedback={archive.error ? <Stack gap={2}><Text role="alert" variant="meta">{archive.error.message}</Text>{historyFeedback}</Stack> : historyFeedback}
    onArchive={(id, archived) => archive.mutate({ id, archived })} archivePending={archive.isPending}
    actions={<AgentActions project={project} agent={agent} />}>
    {current ? <TaskChat key={`${project}:${current.id}`} project={project} task={current.id} presentation="page" /> :
      selected && !query.data ? <div className={styles.unavailable}>{historyFeedback}</div> :
      selected ? <Stack gap={3} className={styles.unavailable}><Text role="alert">This conversation is not available for this agent.</Text>
        <Button onClick={() => select(null)}>New chat</Button></Stack> :
        <NewConversation key={`${project}:${agent}`} project={project} agent={agent}
          onCreated={(job) => { setCreated((previous) => [...previous, job]); select(job.id); }} />}
  </AgentOverview>;
}
