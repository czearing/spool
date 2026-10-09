import { appFetch } from "../platform/request";
import { useCallback, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskConversation } from "../lib/task-conversation";
import { isConversation, mergeConversation } from "../lib/conversation-history";
import type { ChatSubmission } from "../components/ui/chat-input";

async function responseBody(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Conversation unavailable.");
  return body;
}
export function useTaskConversation(project: string, task: string) {
  const client = useQueryClient(), pending = useRef(false);
  const url = `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}/conversation`;
  const key = ["task-conversation", project, task];
  const read = async (before: number | null, signal?: AbortSignal) => {
    const value: unknown = await responseBody(await appFetch(`${url}?events=1${before === null ? "" : `&before=${before}`}`, { signal, cache: "no-store" }));
    if (!isConversation(value) || !value.raw) throw new Error("Invalid conversation history response.");
    return value;
  };
  const query = useQuery<TaskConversation>({
    queryKey: key,
    queryFn: async ({ signal }) => {
      let latest = await read(null, signal);
      const saved = client.getQueryData<TaskConversation>(key);
      while (saved && saved.logId === latest.logId && latest.nextBefore !== null && latest.nextBefore > saved.cursor) {
        const older = await read(latest.nextBefore, signal);
        if (older.nextBefore !== null && older.nextBefore >= latest.nextBefore) throw new Error("Conversation history did not advance.");
        latest = mergeConversation(latest, older, true);
      }
      return latest;
    },
    structuralSharing: (saved, fresh) => mergeConversation(saved, fresh),
    refetchInterval: 1000, refetchIntervalInBackground: false, retry: false, networkMode: "always", gcTime: 0,
  });
  const history = useMutation({
    mutationFn: async (before: number) => {
      const page = await read(before);
      if (page.nextBefore !== null && page.nextBefore >= before) throw new Error("Conversation history did not advance.");
      client.setQueryData(key, saved => mergeConversation(saved, page, true));
    },
    onSettled: () => { pending.current = false; },
  });
  const loadOlder = () => {
    const before = client.getQueryData<TaskConversation>(key)?.nextBefore;
    if (before == null || pending.current) return;
    pending.current = true; history.mutate(before);
  };
  const send = useCallback(async (submission: ChatSubmission, signal: AbortSignal) => {
    const body = await responseBody(await appFetch(url, { method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: submission.id, message: submission.markdown }) }));
    if (body.id !== submission.id || body.state !== "accepted") throw new Error("Spool has not confirmed this message.");
    void client.invalidateQueries({ queryKey: ["task-conversation", project, task] });
    void client.invalidateQueries({ queryKey: ["project-live", project] });
  }, [client, project, task, url]);
  return { ...query, send, loadOlder, loadingOlder: history.isPending, historyError: history.error,
    retry: () => { if (history.error) loadOlder(); else void query.refetch(); } };
}
