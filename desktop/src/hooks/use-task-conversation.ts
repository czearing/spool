import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ConversationError, type TaskConversation } from "../lib/task-conversation";
import { mergeConversation, mergeOperatorMessages } from "../lib/conversation-history";
import { conversationOutbox, isRetryableConversationError, conversationRetryDelay, type ConversationResponseCache } from "../lib/conversation-outbox";
import { conversationQuery, readConversationPage } from "../lib/conversation-query";
import type { ChatSubmission } from "../components/ui/chat-input";

const retryHistory = (failures: number, error: Error) => failures < 2 && isRetryableConversationError(error);

export function useTaskConversation(project: string, task: string) {
  const client = useQueryClient(), pending = useRef<AbortController | null>(null);
  const outbox = useMemo(() => conversationOutbox(project, task), [project, task]);
  const latestResponse = useMemo<ConversationResponseCache>(() => ({}), [project, task]);
  const outgoing = useSyncExternalStore(outbox.subscribe, outbox.snapshot, outbox.snapshot);
  const url = `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}/conversation`;
  const key = useMemo(() => ["task-conversation", project, task], [project, task]);
  const read = (before: number | null, signal?: AbortSignal) =>
    readConversationPage(project, task, before, signal, latestResponse);
  const query = useQuery<TaskConversation>({
    ...conversationQuery(project, task, latestResponse),
    refetchInterval: 1000, refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (query.data) outbox.reconcile(query.data);
  }, [outbox, query.data, outgoing]);
  const flush = useCallback(() => outbox.flush(url, () => {
    void client.invalidateQueries({ queryKey: ["task-conversation", project, task] }).catch(() => {});
  }), [outbox, url, client, project, task]);
  useEffect(() => { void flush(); }, [flush, outgoing]);
  const messageRetries = useMemo(() => new Map(outgoing.filter(message => message.status === "failed")
    .map(message => [message.id, () => { outbox.retry(message.id); void flush(); }])), [outbox, outgoing, flush]);
  const data = useMemo(() => {
    if (!query.data) return outgoing.length ? {
      task: { id: task, title: "", agent: "", status: "incoming", prompt: "", interaction: { messages: outgoing } },
      entries: [], available: false, limited: false, nextBefore: null, cursor: 0, raw: true, logId: null,
      canSend: false, readOnlyReason: "",
    } satisfies TaskConversation : undefined;
    if (!outgoing.length) return query.data;
    const interaction = query.data.task.interaction;
    return { ...query.data, task: { ...query.data.task, interaction: { ...interaction,
      messages: mergeOperatorMessages(outgoing, interaction?.messages) } } };
  }, [query.data, outgoing, task]);
  const history = useMutation({
    mutationFn: async ({ before, logId, cursor, controller }: {
      before: number; logId: TaskConversation["logId"]; cursor: number; controller: AbortController;
    }) => {
      try {
        const page = await read(before, controller.signal);
        const saved = client.getQueryData<TaskConversation>(key);
        if (controller.signal.aborted || !saved || saved.logId !== logId || saved.cursor < cursor ||
            saved.nextBefore !== before) return;
        if (page.logId !== saved.logId) { await client.invalidateQueries({ queryKey: key }); return; }
        if (page.nextBefore !== null && page.nextBefore >= before) throw new Error("Conversation history did not advance.");
        client.setQueryData(key, saved => mergeConversation(saved, page, true));
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ConversationError && error.status === 409) {
          await client.invalidateQueries({ queryKey: key }); return;
        }
        throw error;
      }
    },
    retry: retryHistory,
    retryDelay: conversationRetryDelay, networkMode: "always",
    onSettled: (_data, _error, { controller }) => { if (pending.current === controller) pending.current = null; },
  });
  const generation = useRef(query.data);
  useEffect(() => {
    const previous = generation.current;
    if (query.data && (query.data.logId !== previous?.logId || query.data.cursor < (previous?.cursor ?? 0) ||
        previous && query.data.nextBefore !== null && query.data.nextBefore > previous.cursor)) {
      pending.current?.abort(); pending.current = null; history.reset();
    }
    generation.current = query.data;
  }, [query.data, history.reset]);
  useEffect(() => () => { pending.current?.abort(); pending.current = null; }, [project, task]);
  const loadOlder = useCallback(() => {
    const saved = client.getQueryData<TaskConversation>(key);
    if (saved?.nextBefore == null || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    history.mutate({ before: saved.nextBefore, logId: saved.logId, cursor: saved.cursor, controller });
  }, [client, key, history.mutate]);
  const send = useCallback(async (submission: ChatSubmission, signal: AbortSignal) => {
    signal.throwIfAborted();
    outbox.enqueue(submission);
    void flush();
  }, [outbox, flush]);
  const retry = useCallback(() => {
    if (history.error) loadOlder(); else void query.refetch();
  }, [history.error, loadOlder, query.refetch]);
  return { data, error: query.error, send, loadOlder, loadingOlder: history.isPending, historyError: history.error,
    outboxError: outbox.error || outbox.warning, messageRetries,
    retry };
}
