import { useState } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { AgentJob, AgentJobs } from "../lib/agent-jobs";
import { isAgentJobs } from "../lib/agent-conversations";
import { appFetch } from "../platform/request";
import { useProjectLive } from "../components/project-live-provider";

export function useAgentJobs(project: string, agent: string, initialData?: AgentJobs, selected?: string | null) {
  const client = useQueryClient(), [search, setSearch] = useState("");
  const live = useProjectLive().data?.jobs;
  const queryKey = ["agent-jobs", project, agent, search, selected ?? ""];
  const load = async (cursor: string | undefined, signal: AbortSignal): Promise<AgentJobs> => {
    const params = new URLSearchParams({ search, ...(cursor ? { cursor } : {}), ...(selected ? { selected } : {}) });
    const response = await appFetch(`/api/projects/${encodeURIComponent(project)}/agents/${encodeURIComponent(agent)}/jobs?${params}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    const value: unknown = await response.json();
    if (!response.ok || !isAgentJobs(value)) throw new Error("Could not load conversations. Saved data has not been changed.");
    return value;
  };
  const query = useInfiniteQuery({
    queryKey, queryFn: ({ pageParam, signal }) => load(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: AgentJobs) => page.nextCursor ?? undefined,
    retry: 1,
    initialData: (): InfiniteData<AgentJobs, string | undefined> | undefined => {
      const cached = client.getQueriesData<InfiniteData<AgentJobs, string | undefined>>({
        queryKey: ["agent-jobs", project, agent, search],
      }).map(([, value]) => value).filter(value => value && (!selected ||
        value.pages.some(page => [...page.current, ...page.history].some(job => job.id === selected))))
        .sort((a, b) => b!.pages.length - a!.pages.length)[0];
      return cached ?? (!search && initialData ? { pages: [initialData], pageParams: [undefined] } : undefined);
    },
  });
  const pages = query.data?.pages, last = pages?.at(-1);
  const history = new Map<string, AgentJob>();
  for (const page of pages ?? []) for (const job of page.history) history.set(job.key, job);
  const activity = new Map(live?.agent === agent ? live.data.current.map(job => [job.id, job.activity]) : []);
  const data = last && { current: last.current.map(job => ({ ...job, activity: activity.get(job.id) })),
    history: [...history.values()], nextCursor: last.nextCursor };
  return { ...query, data, search, setSearch, loadMore: () => {
    if (query.hasNextPage && !query.isFetching) void query.fetchNextPage();
  }, loadingMore: query.isFetchingNextPage };
}
