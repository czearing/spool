"use client";

import { appFetch } from "../platform/request";


import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isAgentSettings } from "../lib/agent-settings";

export type AgentDraft = {
  name: string; prompt: string; model: string | null; image: string | null; max_concurrent_runs: number | null;
};
export function useCreateAgent(project: string) {
  const client = useQueryClient();
  return useMutation({ retry: false, networkMode: "always",
    mutationFn: async (draft: AgentDraft) => {
      const response = await appFetch(`/api/projects/${encodeURIComponent(project)}/agents`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Could not create the agent.");
      if (!isAgentSettings(value)) throw new Error("Spool did not confirm the new agent. Reload before retrying.");
      return value;
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["project-live", project] }); },
  });
}
