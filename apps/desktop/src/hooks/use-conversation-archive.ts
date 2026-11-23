import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useProjectLive } from "../components/project-live-provider";
import { appFetch } from "../platform/request";
import { updateConversationArchive } from "../lib/agent-conversations";
import type { AgentJobs } from "../lib/agent-jobs";

export function useConversationArchive(project: string, agent: string) {
  const client = useQueryClient(), live = useProjectLive();
  return useMutation({
    retry: false, networkMode: "always",
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
      const response = await appFetch(`/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(id)}/archive`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived }),
        signal: AbortSignal.timeout(5000),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string"
        ? result.error : "Could not move the conversation.");
      if (!result || typeof result !== "object" || !("id" in result) || result.id !== id ||
        !("archived" in result) || result.archived !== archived) throw new Error("Could not confirm the move. Refresh before retrying.");
    },
    onSuccess: (_result, { id, archived }) => {
      client.setQueriesData<InfiniteData<AgentJobs>>({ queryKey: ["agent-jobs", project, agent] },
        jobs => jobs && { ...jobs, pages: jobs.pages.map(page => updateConversationArchive(page, id, archived)) });
      void client.invalidateQueries({ queryKey: ["desktop-page", encodeURIComponent(project)] });
    },
    onError: () => live.retry(),
  });
}
