import { appFetch } from "../platform/request";
import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { isDashboardData, type DashboardData } from "../lib/dashboard";
import type { DashboardRange } from "../lib/dashboard-range";
import { useProjectLive } from "../components/project-live-provider";

export function useDashboard(project: string, initial: DashboardData, initialVersion: string) {
  const { data: live } = useProjectLive(), client = useQueryClient(), previous = useRef(initialVersion);
  const [range, setRange] = useState<DashboardRange>(initial.range);
  useEffect(() => {
    if (live && live.boardVersion !== previous.current) {
      previous.current = live.boardVersion;
      void client.invalidateQueries({ queryKey: ["dashboard", project] });
    }
  }, [live, project, client]);
  const query = useQuery({
    queryKey: ["dashboard", project, range], initialData: range === initial.range ? initial : undefined, refetchInterval: 60_000,
    staleTime: 30_000, placeholderData: keepPreviousData,
    retry: false, networkMode: "always",
    queryFn: async ({ signal }) => {
      const response = await appFetch(`/api/projects/${encodeURIComponent(project)}/dashboard?range=${range}`, { signal, cache: "no-store" });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error("Task analytics are unavailable.");
      if (!isDashboardData(data) || data.range !== range) throw new Error("Invalid task analytics.");
      return data;
    },
  });
  return { ...query, data: query.data ?? initial, range, setRange };
}
