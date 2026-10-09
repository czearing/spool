"use client";

import { appFetch } from "../platform/request";


import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "../platform/navigation";
import type { CreatedTask, TaskDraft } from "../lib/task-submission";

export function useCreateTask(project: string, onCreated: (task: CreatedTask) => void) {
  const controller = useRef<AbortController | null>(null);
  const pendingKey = useRef<string | null>(null);
  const client = useQueryClient(), router = useRouter();
  useEffect(() => () => { controller.current?.abort(); }, []);
  return useMutation({
    retry: false, networkMode: "always", gcTime: 0,
    mutationFn: async (draft: TaskDraft): Promise<CreatedTask> => {
      const model = draft.model;
      const input = { title: draft.title.trim(), agent: draft.agent, prompt: draft.prompt.trim(), ...(model ? { model } : {}) };
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
      const key = `spool:create:${project}:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      if (pendingKey.current && pendingKey.current !== key) throw new Error("The previous submission may still be preparing. Restore its original details to check it before creating different work.");
      pendingKey.current = key;
      const requestId = sessionStorage.getItem(key) ?? crypto.randomUUID();
      sessionStorage.setItem(key, requestId);
      controller.current = new AbortController();
      const signal = controller.current.signal, url = `/api/projects/${encodeURIComponent(project)}/tasks`;
      const read = async (response: Response): Promise<CreatedTask> => {
        const result: unknown = await response.json();
        if (!response.ok) {
          if (result && typeof result === "object" && "rejected" in result && result.rejected === true) {
            sessionStorage.removeItem(key); pendingKey.current = null;
          }
          throw new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string"
            ? result.error : "Could not confirm task creation. Retry the same submission.");
        }
        if (!result || typeof result !== "object" || !("id" in result) || result.id !== `manual-${requestId}` ||
          !("state" in result) || result.state !== "accepted" ||
          !("notice" in result) || typeof result.notice !== "string") throw new Error("Invalid task acknowledgment. Retry the same submission.");
        return { id: result.id, state: result.state, notice: result.notice };
      };
      const task = await read(await appFetch(url, { method: "POST", signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, requestId }) }));
      sessionStorage.removeItem(key);
      return task;
    },
    onSuccess: (task) => {
      void client.invalidateQueries({ queryKey: ["project-live", project] });
      router.refresh(); onCreated(task);
    },
  });
}
