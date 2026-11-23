"use client";

import { appFetch } from "../platform/request";


import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getPathname, useRouter } from "../platform/navigation";
import type { ProjectLive } from "../lib/project-live";

export function useDeleteAgent(project: string, agent: string) {
  const client = useQueryClient(), router = useRouter();
  return useMutation({
    retry: false, networkMode: "always", gcTime: 0,
    mutationFn: async () => {
      const response = await appFetch(`/api/projects/${encodeURIComponent(project)}/agents/${encodeURIComponent(agent)}`, { method: "DELETE" });
      if (response.status === 204) return;
      const result: unknown = await response.json();
      const message = result && typeof result === "object" && "error" in result && typeof result.error === "string"
        ? result.error : "Could not delete the agent. Try again.";
      throw new Error(message);
    },
    onSuccess: () => {
      const queryKey = ["project-live", project];
      client.setQueryData<ProjectLive>(queryKey, (data) => data && { ...data, agents: data.agents.filter(({ id }) => id !== agent) });
      client.removeQueries({ queryKey: ["prompt", project, agent], exact: true });
      const agentPath = `/${project}/agents/${encodeURIComponent(agent)}`;
      client.removeQueries({ queryKey: ["desktop-page", project],
        predicate: query => query.queryKey[2] === agentPath || query.queryKey[2] === `${agentPath}/prompt` });
      client.removeQueries({ queryKey: ["agent-jobs", project, agent], exact: true });
      const pathname = getPathname();
      if (pathname === agentPath || pathname.startsWith(`${agentPath}/`)) router.replace(`/${project}`);
      router.refresh();
    },
  });
}
