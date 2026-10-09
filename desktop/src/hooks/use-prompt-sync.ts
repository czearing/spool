"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AgentPrompt } from "../lib/agents";
import { PromptSync } from "../lib/prompt-sync";
import { requestPrompt } from "../lib/prompt-api";
import { useNavigationGuard } from "../components/navigation-guard";
import type { EditorHandle } from "../components/ui/editor";

export function usePromptSync(project: string, document: AgentPrompt) {
  const url = `/api/projects/${encodeURIComponent(project)}/agents/${encodeURIComponent(document.id)}`;
  const mutation = useMutation({
    retry: false, networkMode: "always", gcTime: 0,
    mutationFn: (input: Pick<AgentPrompt, "prompt" | "revision">) => {
      const body = JSON.stringify(input);
      return requestPrompt(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body,
        keepalive: new TextEncoder().encode(body).length < 60_000 });
    },
  });
  const [sync] = useState(() => new PromptSync(document, mutation.mutateAsync));
  const [ready, setReady] = useState(false);
  const state = useSyncExternalStore(sync.subscribe, sync.snapshot, sync.snapshot);
  const { setDirty, registerFlush } = useNavigationGuard();
  const remote = useQuery({
    queryKey: ["prompt", project, document.id], enabled: ready, retry: false, networkMode: "always",
    refetchInterval: 2000, refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => { const epoch = sync.epoch; return { document: await requestPrompt(url, { signal }), epoch }; },
  });
  useEffect(() => { if (remote.data) sync.observe(remote.data.document, remote.data.epoch); }, [remote.data, sync]);
  useEffect(() => { setDirty(state.dirty); return () => setDirty(false); }, [state.dirty, setDirty]);
  useEffect(() => registerFlush(sync.flush), [registerFlush, sync]);
  useEffect(() => {
    const flush = () => { if (documentIsHidden()) void sync.flush(); };
    window.addEventListener("pagehide", sync.flush);
    globalThis.document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", sync.flush);
      globalThis.document.removeEventListener("visibilitychange", flush);
      sync.disconnect();
    };
  }, [sync]);
  const attach = useCallback((editor: EditorHandle | null) => {
    if (editor) { sync.connect(() => editor.getMarkdown(), (markdown) => editor.setMarkdown(markdown)); setReady(true); }
  }, [sync]);
  return { sync, state, attach, syncError: remote.error?.message,
    reload: async () => { try { sync.accept(await requestPrompt(url)); } catch (error) { sync.fail(error instanceof Error ? error : new Error(String(error))); } } };
}
function documentIsHidden() { return globalThis.document.visibilityState === "hidden"; }
