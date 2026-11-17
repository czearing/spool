import { isConversation, mergeConversation } from "./conversation-history";
import { pendingConversationMessages, fetchConversation, isRetryableConversationError, conversationRetryDelay, type ConversationResponseCache } from "./conversation-outbox";
import type { TaskConversation } from "./task-conversation";

export async function readConversationPage(project: string, task: string, before: number | null,
  signal?: AbortSignal, response?: ConversationResponseCache) {
  const url = `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}/conversation`;
  const value: unknown = await fetchConversation(`${url}?events=1${before === null ? "" : `&before=${before}`}`,
    { signal, cache: "no-store" }, before === null ? response : undefined);
  if (!isConversation(value) || value.task.id !== task || !value.raw && (value.available !== false || value.entries.length))
    throw new Error("Invalid conversation history response.");
  return value.raw ? value : { ...value, raw: true, logId: null };
}

export function conversationQuery(project: string, task: string, response: ConversationResponseCache = {}) {
  const key = ["task-conversation", project, task] as const;
  return {
    queryKey: key, staleTime: 1000, networkMode: "always" as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<TaskConversation> => {
      let latest = await readConversationPage(project, task, null, signal, response);
      const timestamps = new Map(pendingConversationMessages(project, task).map(message => [message.id, message.created_at]));
      if (timestamps.size && latest.task.interaction?.messages?.length) latest = { ...latest,
        task: { ...latest.task, interaction: { ...latest.task.interaction,
          messages: latest.task.interaction.messages.map(message => ({ ...message,
            created_at: timestamps.get(message.id) ?? message.created_at })) } } };
      return latest;
    },
    structuralSharing: (saved: unknown, fresh: unknown) => mergeConversation(saved, fresh),
    retry: (failures: number, error: Error) => failures < 2 && isRetryableConversationError(error),
    retryDelay: conversationRetryDelay,
  };
}
