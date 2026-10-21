import { useQuery } from "@tanstack/react-query";
import { appFetch } from "../platform/request";
import { isRunnerLogs } from "../lib/runner-logs";

export function useRunnerLogs(project: string, runner: string, run: string | null) {
  return useQuery({
    queryKey: ["runner-logs", project, runner, run], retry: false, refetchInterval: 2000,
    queryFn: async ({ signal }) => {
      const base = `/api/projects/${encodeURIComponent(project)}/runners/${encodeURIComponent(runner)}/output`;
      const response = await appFetch(`${base}${run ? `?run=${encodeURIComponent(run)}` : ""}`, { signal, cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "Run not found." : "Runner logs are unavailable.");
      const value: unknown = await response.json();
      if (!isRunnerLogs(value)) throw new Error("Invalid runner log response.");
      return value;
    },
  });
}
