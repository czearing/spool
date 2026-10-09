"use client";

import { appFetch } from "../platform/request";


import { createContext, useContext, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ProjectLive } from "../lib/project-live";
import { isTaskPreparation } from "../lib/task-preparation";
import { isJobCompletion } from "../lib/job-completions";
import { useCompletionNotifications } from "../hooks/use-completion-notifications";
import dynamic from "../platform/lazy";
import { isAgentIcon } from "../lib/agent-settings";

const CompletionToasts = dynamic(() => import("./completion-toasts").then((module) => module.CompletionToasts));
const LiveContext = createContext<{ project?: string; data?: ProjectLive; error: Error | null }>({ error: null });
export const useProjectLive = () => useContext(LiveContext);
async function load(project: string, signal: AbortSignal): Promise<ProjectLive> {
  const response = await appFetch(`/api/projects/${encodeURIComponent(project)}/live`, { signal, cache: "no-store" });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error("Live activity is unavailable.");
  if (!value || typeof value !== "object" || !("agents" in value) || !Array.isArray(value.agents) ||
    !("successful" in value) || typeof value.successful !== "number" ||
    !("boardVersion" in value) || typeof value.boardVersion !== "string") throw new Error("Invalid live activity response.");
  const agents = value.agents.map((agent: unknown) => {
    if (!agent || typeof agent !== "object" || !("id" in agent) || typeof agent.id !== "string" ||
      !("active" in agent) || typeof agent.active !== "number" || !Number.isSafeInteger(agent.active) || agent.active < 0) throw new Error("Invalid agent activity.");
    if ("icon" in agent && !isAgentIcon(agent.icon)) throw new Error("Invalid agent icon.");
    const imageVersion = "imageVersion" in agent ? agent.imageVersion : null;
    if (imageVersion !== null && (typeof imageVersion !== "string" || !/^[a-f0-9]{64}$/.test(imageVersion))) throw new Error("Invalid agent image revision.");
    return { id: agent.id, active: agent.active, icon: "icon" in agent && isAgentIcon(agent.icon) ? agent.icon : "bot", imageVersion };
  });
  if (!("preparations" in value) || !Array.isArray(value.preparations) || !value.preparations.every(isTaskPreparation)) {
    throw new Error("Invalid task preparation response.");
  }
  if (!("completed" in value) || !Array.isArray(value.completed) || !value.completed.every(isJobCompletion)) throw new Error("Invalid completion response.");
  return { agents, successful: value.successful, boardVersion: value.boardVersion, preparations: value.preparations, completed: value.completed };
}
function LiveQuery({ project, children }: { project: string; children: ReactNode }) {
  const { data, error } = useQuery({
    queryKey: ["project-live", project], queryFn: ({ signal }) => load(project, signal),
    refetchInterval: 2000, refetchIntervalInBackground: false, retry: false, networkMode: "always",
  });
  const { notifications, dismiss } = useCompletionNotifications(error ? undefined : data?.completed);
  return <LiveContext.Provider value={{ project, data, error }}>{children}
    {notifications.length > 0 && <CompletionToasts notifications={notifications} onDismiss={dismiss} />}
  </LiveContext.Provider>;
}
export function ProjectLiveProvider({ project, children }: { project: string; children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}><LiveQuery project={project}>{children}</LiveQuery></QueryClientProvider>;
}
