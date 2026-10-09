"use client";

import { appFetch } from "../platform/request";


import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "../platform/navigation";
import type { ProjectLive } from "../lib/project-live";

export function useDeleteAgent(project: string, agent: string) {
  const client = useQueryClient(), router = useRouter(), pathname = usePathname();
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
    onSuccess: async () => {
      const queryKey = ["project-live", project];
      await client.cancelQueries({ queryKey });
      client.setQueryData<ProjectLive>(queryKey, (data) => data && { ...data, agents: data.agents.filter(({ id }) => id !== agent) });
      client.removeQueries({ queryKey: ["prompt", project, agent], exact: true });
      void client.invalidateQueries({ queryKey });
      const agentPath = `/${project}/agents/${encodeURIComponent(agent)}`;
      if (pathname === agentPath || pathname.startsWith(`${agentPath}/`)) router.replace(`/${project}`);
      else router.refresh();
    },
  });
}
