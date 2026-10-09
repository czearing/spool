"use client";

import { useState } from "react";
import { navigate, useSearchParams } from "../platform/navigation";
import dynamic from "../platform/lazy";
import type { AgentJob, AgentJobs } from "../lib/agent-jobs";
import { agentConversations } from "../lib/agent-conversations";
import { AgentOverview } from "./agent-overview";
import { AgentActions } from "./agent-actions";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { Button } from "./ui/button";
import styles from "./agent-overview.module.css";

const loading = () => <Text role="status" className={styles.unavailable}>Loading conversation...</Text>;
const TaskChat = dynamic(() => import("./task-chat"), { ssr: false, loading });
const NewConversation = dynamic(() => import("./agent-new-conversation"), { ssr: false, loading });

export function AgentConversations({ project, agent, jobs }: { project: string; agent: string; jobs: AgentJobs }) {
  const selected = useSearchParams().get("task"), [created, setCreated] = useState<AgentJob[]>([]);
  const ids = new Set(agentConversations(jobs).map((job) => job.id));
  const visible = { current: [...created.filter((job) => !ids.has(job.id)), ...jobs.current], history: jobs.history };
  const current = agentConversations(visible).find((job) => job.id === selected);
  const select = (id: string | null) => {
    if (selected !== id) navigate(`/${encodeURIComponent(project)}/agents/${encodeURIComponent(agent)}${id ? `?task=${encodeURIComponent(id)}` : ""}`);
  };
  return <AgentOverview project={project} agent={agent} jobs={visible} selected={selected} onSelect={select}
    actions={<AgentActions project={project} agent={agent} />}>
    {current ? <TaskChat key={`${project}:${current.id}`} project={project} task={current.id} presentation="page" /> :
      selected ? <Stack gap={3} className={styles.unavailable}><Text role="alert">This conversation is not available for this agent.</Text>
        <Button onClick={() => select(null)}>New chat</Button></Stack> :
        <NewConversation key={`${project}:${agent}`} project={project} agent={agent}
          onCreated={(job) => { setCreated((previous) => [...previous, job]); select(job.id); }} />}
  </AgentOverview>;
}
