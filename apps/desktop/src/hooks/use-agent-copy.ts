"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { appFetch } from "../platform/request";
import { requestPrompt } from "../lib/prompt-api";
import type { AgentCatalog, CopyAgent } from "../lib/agent-copy";

export type AgentSource = { project: string; projectName: string; agent: string };
export function useAgentCopy(project: string, open: boolean, onCopied: (name: string) => void) {
  const client = useQueryClient(), [source, setSource] = useState<AgentSource>();
  const url = `/api/projects/${encodeURIComponent(project)}/agent-copy`;
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
  const mutation = useMutation({ retry: false, networkMode: "always", mutationFn: async (input: CopyAgent) => {
    const response = await appFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? "Could not copy the agent.");
    if (value.name !== input.name || value.copied !== true) throw new Error("Copy was not confirmed. Reload before retrying.");
    return input.name;
  }, onSuccess: name => {
    void client.invalidateQueries({ queryKey: ["agent-library"] });
    onCopied(name);
  } });
  return { catalog, preview, source, mutation, select: (value: AgentSource) => { mutation.reset(); setSource(value); } };
}
