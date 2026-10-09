import { appFetch } from "../platform/request";
import { useQuery } from "@tanstack/react-query";
import type { DashboardRange } from "../lib/dashboard-range";
import { isToolUsage } from "../lib/tool-usage";

export function useToolUsage(project: string, range: DashboardRange) {
  return useQuery({
    queryKey: ["tool-usage", project, range], staleTime: 30_000, refetchInterval: 60_000,
    retry: false, networkMode: "always",
    queryFn: async ({ signal }) => {
      const response = await appFetch(`/api/projects/${encodeURIComponent(project)}/tool-usage?range=${range}`, { signal, cache: "no-store" });
      if (!response.ok) throw new Error("Tool usage is unavailable.");
      const data: unknown = await response.json();
      if (!isToolUsage(data) || data.range !== range) throw new Error("Invalid tool usage.");
      return data;
    },
  });
}
