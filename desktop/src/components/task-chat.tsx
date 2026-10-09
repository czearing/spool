"use client";

import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { useTaskConversation } from "../hooks/use-task-conversation";
import { useTaskChatDraft } from "../hooks/use-task-chat-draft";
import { TaskChatView } from "./task-chat-view";
import type { ChatSubmission } from "./ui/chat-input";
import { Text } from "./ui/text";
import styles from "./task-chat.module.css";

export default function TaskChat({ project, task, presentation, onDetailsChange }: {
  project: string; task: string; presentation?: ComponentProps<typeof TaskChatView>["presentation"];
  onDetailsChange?: (details: { id: string; title: string; agent?: string }) => void;
}) {
  const query = useTaskConversation(project, task), draft = useTaskChatDraft(project, task);
  const { prepare, accepted } = draft, { send } = query;
  const [notice, setNotice] = useState("");
  const title = query.data?.task.title, agent = query.data?.task.agent;
  useEffect(() => { if (title) onDetailsChange?.({ id: task, title, agent }); }, [task, title, agent, onDetailsChange]);
  const submit = useCallback(async (input: ChatSubmission, signal: AbortSignal) => {
    const submission = prepare(input);
    await send(submission, signal);
    if (!signal.aborted) { accepted(submission); setNotice("Message queued for the agent."); }
  }, [prepare, accepted, send]);
  return <>
    <TaskChatView presentation={presentation} data={query.data} error={query.error?.message ?? query.historyError?.message} draftError={draft.error}
      onLoadOlder={query.historyError ? undefined : query.loadOlder} loadingOlder={query.loadingOlder}
      onRetry={query.retry} composer={{ label: "Message agent", placeholder: "Message agent...",
        initialMarkdown: draft.initialMarkdown, onDraftChange: draft.onDraftChange, onSubmit: submit }} />
    <Text role="status" className={styles.announcement}>{notice}</Text>
  </>;
}
