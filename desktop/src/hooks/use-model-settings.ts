"use client";

import { appFetch } from "../platform/request";


import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModelSettings } from "../lib/model-settings";
import type { ModelOption } from "../lib/model-catalog";

async function read<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Settings request failed.");
  return data;
}
export function useModelSettings(project: string, agent: string | undefined, open: boolean) {
  const client = useQueryClient();
  const url = `/api/projects/${encodeURIComponent(project)}${agent ? `/agents/${encodeURIComponent(agent)}` : ""}/settings`;
  const key = ["model-settings", project, agent ?? null];
  const query = useQuery({ queryKey: key, enabled: open, retry: false, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const value = await appFetch(url, { signal }).then(read<ModelSettings>);
      return agent ? { ...value, title: value.title ?? agent } : value;
    } });
  const catalog = useModelCatalog(open);
  const [draft, setDraft] = useState<ModelSettings>();
  useEffect(() => { setDraft(open ? query.data : undefined); }, [open, query.data, project, agent]);
  const mutation = useMutation({ retry: false, networkMode: "always",
    mutationFn: (value: ModelSettings) => appFetch(url, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: value.model, revision: value.revision, ...(agent ? {
        title: value.title?.trim(), image: value.image, max_concurrent_runs: value.maxConcurrentRuns,
      } : { autopilot: value.autopilot }) }) }).then(read<ModelSettings>),
    onSuccess: (value) => {
      client.setQueryData(key, value);
      if (agent) client.setQueryData<import("../lib/project-live").ProjectLive>(["project-live", project],
        live => live && { ...live, agents: live.agents.map(item => item.id === agent ? { ...item, title: value.title } : item) });
      void client.invalidateQueries({ queryKey: ["model-settings", project] });
    },
  });
  const reset = mutation.reset;
  useEffect(() => { if (open) reset(); }, [open, url, reset]);
  return { draft, options: catalog.data ?? [], pending: mutation.isPending,
    loading: query.isPending || !draft,
    catalogLoading: catalog.isPending,
    catalogError: catalog.error?.message,
    error: mutation.error?.message ?? query.error?.message,
    setModel: (model: string | null) => setDraft((value) => value && { ...value, model }),
    setAutopilot: (autopilot: boolean) => setDraft((value) => value && { ...value, autopilot }),
    setAgent: (settings: Pick<ModelSettings, "title" | "image" | "maxConcurrentRuns">) =>
      setDraft((value) => value && { ...value, ...settings }),
    save: async () => { if (!draft) throw new Error("Settings are still loading."); await mutation.mutateAsync(draft); },
    reload: () => {
      mutation.reset();
      void query.refetch().then(result => { if (result.data) setDraft(result.data); });
      void catalog.refetch();
    },
    reloadCatalog: () => { void catalog.refetch(); },
  };
}
export function useModelCatalog(open: boolean) {
  return useQuery({ queryKey: ["model-catalog"], enabled: open, staleTime: 300000, retry: 2,
    retryDelay: attempt => 1000 * 2 ** attempt, refetchOnWindowFocus: false, networkMode: "always",
    queryFn: ({ signal }) => appFetch("/api/models", { signal }).then(read<ModelOption[]>) });
}
