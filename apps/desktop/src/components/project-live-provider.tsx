"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { notifyManager, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectLive } from "../lib/project-live";
import { isAgentJobs } from "../lib/agent-conversations";
import { isTaskPreparation } from "../lib/task-preparation";
import { useCompletionNotifications } from "../hooks/use-completion-notifications";
import { CompletionToasts } from "./completion-toasts";
import { isAgentIcon, isAgentTitle } from "../lib/agent-settings";
import { AppEventSource } from "../platform/event-source";
import { usePathname } from "../platform/navigation";

const LiveContext = createContext<{ project?: string; data?: ProjectLive; error: Error | null; retry: () => void;
  setConversationAgent: (agent: string | undefined) => void }>({
  error: null, retry: () => {}, setConversationAgent: () => {},
});
export const useProjectLive = () => useContext(LiveContext);
function parseLive(value: unknown): ProjectLive {
  if (!value || typeof value !== "object" || !("agents" in value) || !Array.isArray(value.agents) ||
    !("successful" in value) || typeof value.successful !== "number" ||
    !("boardVersion" in value) || typeof value.boardVersion !== "string") throw new Error("Invalid live activity response.");
  const agents = value.agents.map((agent: unknown) => {
    if (!agent || typeof agent !== "object" || !("id" in agent) || typeof agent.id !== "string" ||
      !("active" in agent) || typeof agent.active !== "number" || !Number.isSafeInteger(agent.active) || agent.active < 0) throw new Error("Invalid agent activity.");
    if ("icon" in agent && !isAgentIcon(agent.icon)) throw new Error("Invalid agent icon.");
    const title = "title" in agent ? agent.title : agent.id;
    if (!isAgentTitle(title)) throw new Error("Invalid agent title.");
    const imageVersion = "imageVersion" in agent ? agent.imageVersion : null;
    if (imageVersion !== null && (typeof imageVersion !== "string" || !/^[a-f0-9]{64}$/.test(imageVersion))) throw new Error("Invalid agent image revision.");
    const pending = "pending" in agent ? agent.pending : 0, starting = "starting" in agent ? agent.starting : 0;
    if (typeof pending !== "number" || !Number.isSafeInteger(pending) || pending < 0 ||
      typeof starting !== "number" || !Number.isSafeInteger(starting) || starting < 0) throw new Error("Invalid pending activity.");
    return { id: agent.id, title, active: agent.active, pending, starting,
      icon: "icon" in agent && isAgentIcon(agent.icon) ? agent.icon : "bot", imageVersion };
  });
  if (!("preparations" in value) || !Array.isArray(value.preparations) || !value.preparations.every(isTaskPreparation)) {
    throw new Error("Invalid task preparation response.");
  }
  let jobs: ProjectLive["jobs"];
  if ("jobs" in value && value.jobs !== undefined) {
    const selected = value.jobs;
    if (!selected || typeof selected !== "object" || !("agent" in selected) || typeof selected.agent !== "string" ||
      !("data" in selected) || !isAgentJobs(selected.data)) throw new Error("Invalid conversation activity.");
    jobs = { agent: selected.agent, data: selected.data };
  }
  return { agents, successful: value.successful, boardVersion: value.boardVersion,
    preparations: value.preparations, jobs };
}
export function ProjectLiveProvider({ project, children }: { project: string; children: ReactNode }) {
  const client = useQueryClient(), pathname = usePathname();
  const agent = /^\/[^/]+\/agents\/([^/]+)(?:\/prompt)?$/.exec(pathname)?.[1];
  const [attempt, setAttempt] = useState(0), [error, setError] = useState<Error | null>(null);
  const [conversationAgent, setConversationAgent] = useState<string>();
  const { data } = useQuery<ProjectLive>({ queryKey: ["project-live", project], enabled: false });
  useEffect(() => {
    const source = new AppEventSource(`/api/projects/${encodeURIComponent(project)}/live${agent ? `?agent=${agent}` : ""}`);
    const unavailable = () => setError(new Error("Live activity is unavailable."));
    source.onmessage = event => {
      try {
        const snapshot = parseLive(JSON.parse(event.data));
        if (snapshot.jobs && snapshot.jobs.agent !== decodeURIComponent(agent ?? "")) throw new Error("Unexpected agent activity.");
        notifyManager.batch(() => {
          client.setQueryData(["project-live", project], snapshot);
          if (snapshot.jobs) client.setQueryData(["agent-jobs", project, snapshot.jobs.agent], snapshot.jobs.data);
        });
        setError(null);
      } catch { unavailable(); source.close(); }
    };
    source.addEventListener("unavailable", unavailable);
    source.onerror = unavailable;
    return () => source.close();
  }, [client, project, agent, attempt]);
  const chatAgent = /^\/[^/]+\/agents\/([^/]+)$/.exec(pathname)?.[1];
  const { notifications, dismiss } = useCompletionNotifications(project,
    conversationAgent ?? (chatAgent ? decodeURIComponent(chatAgent) : undefined));
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const value = useMemo(() => ({ project, data, error, retry, setConversationAgent }), [project, data, error, retry]);
  return <LiveContext.Provider value={value}>{children}
    {notifications.length > 0 && <CompletionToasts notifications={notifications} onDismiss={dismiss} />}
  </LiveContext.Provider>;
}
