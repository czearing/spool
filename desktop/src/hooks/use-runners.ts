import { useQuery } from "@tanstack/react-query";
import { appFetch } from "../platform/request";
import { isRunnerSnapshot } from "../lib/runners";

export function useRunners(project: string) {
  return useQuery({
    queryKey: ["runners", project], retry: false, refetchInterval: 5000,
    queryFn: async ({ signal }) => {
      const response = await appFetch(`/api/projects/${encodeURIComponent(project)}/runners`, { signal });
      if (!response.ok) throw new Error("Runner status is unavailable.");
      const value: unknown = await response.json();
      if (!isRunnerSnapshot(value)) throw new Error("Invalid runner status response.");
      return value;
    },
  });
}
