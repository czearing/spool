import { appFetch } from "../platform/request";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ConversationError, type TaskConversation } from "../lib/task-conversation";
import { mergeConversation } from "../lib/conversation-history";
import { readConversationPage } from "../lib/conversation-client";
import { pendingConversationMessages } from "../lib/conversation-pending";
import type { ChatSubmission } from "../components/ui/chat-input";

async function responseBody(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new ConversationError(typeof body.error === "string" ? body.error : "Conversation unavailable.",
    response.status, body.rejected === true);
  return body;
}
export function useTaskConversation(project: string, task: string) {
  const client = useQueryClient(), pending = useRef(false);
  const messages = useMemo(() => pendingConversationMessages(project, task), [project, task]);
  const outgoing = useSyncExternalStore(messages.subscribe, messages.snapshot, messages.snapshot);
  const url = `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}/conversation`;
  const key = ["task-conversation", project, task];
  const read = (before: number | null, signal?: AbortSignal) =>
    readConversationPage(`${url}?events=1${before === null ? "" : `&before=${before}`}`, signal);
  const query = useQuery<TaskConversation>({
    queryKey: key,
    queryFn: ({ signal }) => read(null, signal),
    structuralSharing: (saved, fresh) => mergeConversation(saved, fresh),
    refetchInterval: 1000, refetchIntervalInBackground: false, retry: false, networkMode: "always", gcTime: 0,
  });
  useEffect(() => { if (query.data) messages.reconcile(query.data); }, [messages, query.data, outgoing]);
  const data = useMemo(() => {
    const value = query.data ?? (outgoing.length ? {
      task: { id: task, title: "", agent: "", status: "incoming", prompt: "" },
      entries: [], available: false, limited: false, nextBefore: null, cursor: 0,
      canSend: false, readOnlyReason: "Loading conversation...", raw: true, logId: null,
    } satisfies TaskConversation : undefined);
    if (!value || !outgoing.length) return value;
    const interaction = value.task.interaction;
    const merged = new Map(outgoing.map(message => [message.id, message]));
    for (const message of interaction?.messages ?? []) merged.set(message.id, {
      ...message, created_at: merged.get(message.id)?.created_at ?? message.created_at,
    });
    return { ...value, task: { ...value.task, interaction: { ...interaction, messages: [...merged.values()] } } };
  }, [query.data, outgoing, task]);
  const history = useMutation({
    mutationFn: async ({ before, logId, cursor }: { before: number; logId: TaskConversation["logId"]; cursor: number }) => {
      const page = await read(before);
      const saved = client.getQueryData<TaskConversation>(key);
      if (!saved || saved.logId !== logId || saved.cursor < cursor || saved.nextBefore !== before) return;
      if (page.nextBefore !== null && page.nextBefore >= before) throw new Error("Conversation history did not advance.");
      client.setQueryData(key, saved => mergeConversation(saved, page, true));
    },
    onSettled: () => { pending.current = false; },
  });
  const loadOlder = () => {
    const saved = client.getQueryData<TaskConversation>(key);
    if (saved?.nextBefore == null || pending.current) return;
    pending.current = true; history.mutate({ before: saved.nextBefore, logId: saved.logId, cursor: saved.cursor });
  };
  const send = useCallback(async (submission: ChatSubmission, signal: AbortSignal) => {
    signal.throwIfAborted();
    messages.enqueue(submission);
    try {
      const body = await responseBody(await appFetch(url, { method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: submission.id, message: submission.markdown }) }));
      if (body.id !== submission.id || !["accepted", "queued"].includes(body.state)) throw new Error("Spool has not confirmed this message.");
      messages.settle(submission.id);
    } catch (error) {
      messages.settle(submission.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    void client.invalidateQueries({ queryKey: ["task-conversation", project, task] });
    void client.invalidateQueries({ queryKey: ["project-live", project] });
  }, [client, project, task, url, messages]);
  return { ...query, data, send, loadOlder, loadingOlder: history.isPending, historyError: history.error,
    retry: () => { if (history.error) loadOlder(); else void query.refetch(); } };
}
