"use client";

import { useCallback, useEffect, useState, type ComponentProps } from "react";
import type { useTaskConversation } from "../hooks/use-task-conversation";
import { useTaskChatDraft } from "../hooks/use-task-chat-draft";
import { TaskChatView } from "./task-chat-view";
import type { ChatSubmission } from "./ui/chat-input";
import { Text } from "./ui/text";
import { MessageDeliveryRecovery } from "./message-delivery-recovery";
import styles from "./task-chat.module.css";

export default function TaskChatContent({ project, task, presentation, onDetailsChange, query }: {
  project: string; task: string; presentation?: ComponentProps<typeof TaskChatView>["presentation"];
  onDetailsChange?: (details: { id: string; title: string; agent?: string }) => void;
  query: ReturnType<typeof useTaskConversation>;
}) {
  const draft = useTaskChatDraft(project, task);
  const { accepted } = draft, { send } = query;
  const [notice, setNotice] = useState("");
  const title = query.data?.task.title, agent = query.data?.task.agent;
  useEffect(() => { if (title) onDetailsChange?.({ id: task, title, agent }); }, [task, title, agent, onDetailsChange]);
  const submit = useCallback(async (input: ChatSubmission, signal: AbortSignal) => {
    await send(input, signal);
    if (!signal.aborted) { accepted(input); setNotice("Message saved for delivery."); }
  }, [accepted, send]);
  return <>
    <TaskChatView presentation={presentation} data={query.data} error={query.error?.message ?? query.historyError?.message} draftError={draft.error || query.outboxError} messageRetries={query.messageRetries}
      recovery={query.data && <MessageDeliveryRecovery project={project} task={task}
        messages={query.data.task.interaction?.messages ?? []} available={query.data.recoveryAvailable === true}
        onResolved={query.retry} />}
      onLoadOlder={query.historyError ? undefined : query.loadOlder} loadingOlder={query.loadingOlder}
      onRetry={query.retry} composer={{ label: "Message agent", placeholder: "Message agent...",
        initialMarkdown: draft.initialMarkdown, onDraftChange: draft.onDraftChange, onSubmit: submit }} />
    <Text role="status" className={styles.announcement}>{notice}</Text>
  </>;
}
