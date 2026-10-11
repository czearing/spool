"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { appFetch } from "../platform/request";
import { requestPrompt } from "../lib/prompt-api";
import type { AgentCatalog, ImportAgent } from "../lib/agent-import";

export type AgentSource = { project: string; projectName: string; agent: string };
export function useAgentImport(project: string, open: boolean, onImported: (name: string) => void) {
  const client = useQueryClient(), [source, setSource] = useState<AgentSource>();
  const url = `/api/projects/${encodeURIComponent(project)}/agent-import`;
  const catalog = useQuery({ queryKey: ["agent-library", project], enabled: open, retry: false, refetchOnWindowFocus: false,
    queryFn: async ({ signal }): Promise<AgentCatalog> => {
      const response = await appFetch(url, { signal }), value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Could not load the agent library.");
      return value;
    },
  });
  const preview = useQuery({ queryKey: ["agent-library-preview", source?.project, source?.agent], enabled: open && !!source,
    retry: false, refetchOnWindowFocus: false,
    queryFn: ({ signal }) => {
      if (!source) throw new Error("Choose an agent to preview.");
      return requestPrompt(`/api/projects/${encodeURIComponent(source.project)}/agents/${encodeURIComponent(source.agent)}`, { signal });
    },
  });
  const mutation = useMutation({ retry: false, networkMode: "always", mutationFn: async (input: ImportAgent) => {
    const response = await appFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? "Could not import the agent.");
    if (value.name !== input.name || value.shared !== true) throw new Error("Import was not confirmed. Reload before retrying.");
    return input.name;
  }, onSuccess: name => {
    void client.invalidateQueries({ queryKey: ["project-live", project] });
    void client.invalidateQueries({ queryKey: ["agent-library"] });
    onImported(name);
  } });
  return { catalog, preview, source, mutation, select: (value: AgentSource) => { mutation.reset(); setSource(value); } };
}
