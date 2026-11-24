import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { AgentJob, AgentJobs } from "../lib/agent-jobs";
import { isAgentJobs } from "../lib/agent-conversations";
import { readJson, readQueryRecovery } from "../platform/read-json";
import { useProjectLive } from "../components/project-live-provider";

export function useAgentJobs(project: string, agent: string, initialData?: AgentJobs, selected?: string | null) {
  const client = useQueryClient(), [search, setSearch] = useState("");
  const [term, setTerm] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search), 150);
    return () => clearTimeout(timer);
  }, [search]);
  const live = useProjectLive().data;
  const queryKey = ["agent-jobs", project, agent, term, selected ?? ""];
  const load = async (cursor: string | undefined, signal: AbortSignal): Promise<AgentJobs> => {
    const params = new URLSearchParams({ search: term, ...(cursor ? { cursor } : {}), ...(selected ? { selected } : {}) });
    const value = await readJson<unknown>(
      `/api/projects/${encodeURIComponent(project)}/agents/${encodeURIComponent(agent)}/jobs?${params}`, signal,
      "Could not load conversations. Saved data has not been changed.");
    if (!isAgentJobs(value)) throw new Error("Could not load conversations. Saved data has not been changed.");
    return value;
  };
  const query = useInfiniteQuery({
    queryKey, queryFn: ({ pageParam, signal }) => load(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: AgentJobs) => page.nextCursor ?? undefined,
    ...readQueryRecovery,
    placeholderData: (previous, query) => query?.queryKey[1] === project && query.queryKey[2] === agent ? previous : undefined,
    initialData: (): InfiniteData<AgentJobs, string | undefined> | undefined => {
      const cached = client.getQueriesData<InfiniteData<AgentJobs, string | undefined>>({
        queryKey: ["agent-jobs", project, agent, term],
      }).map(([, value]) => value).filter(value => value && (!selected ||
        value.pages.some(page => [...page.current, ...page.history].some(job => job.id === selected))))
        .sort((a, b) => b!.pages.length - a!.pages.length)[0];
      return cached ?? (!term && initialData ? { pages: [initialData], pageParams: [undefined] } : undefined);
    },
  });
  const pages = query.data?.pages;
  const data = useMemo(() => {
    if (!pages) return;
    const last = pages.at(-1);
    if (!last) return;
    const history = new Map<string, AgentJob>();
    for (const page of pages) for (const job of page.history) history.set(job.key, job);
    const activity = new Map(live?.work?.filter(job => job.agent === agent).map(job => [job.id, job.state]) ??
      (live?.jobs?.agent === agent ? live.jobs.data.current.map(job => [job.id, job.activity]) : []));
    return { current: last.current.map(job => ({ ...job, activity: activity.get(job.id) })),
      history: [...history.values()], nextCursor: last.nextCursor };
  }, [pages, live?.work, live?.jobs, agent]);
  return { ...query, data, search, setSearch, isFetching: query.isFetching || search !== term, loadMore: () => {
    if (query.hasNextPage && !query.isFetching && search === term && !query.isPlaceholderData) void query.fetchNextPage();
  }, loadingMore: query.isFetchingNextPage };
}
