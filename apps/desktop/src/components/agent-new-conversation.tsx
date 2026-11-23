"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateTask } from "../hooks/use-create-task";
import { useTaskChatDraft } from "../hooks/use-task-chat-draft";
import { conversationTitle } from "../lib/agent-conversations";
import type { AgentJob } from "../lib/agent-jobs";
import type { ChatInputHandle } from "./ui/chat-input";
import { TaskChatView } from "./task-chat-view";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import type { OperatorMessage, TaskConversation } from "../lib/task-conversation";

export default function AgentNewConversation({ project, agent, onCreated }: {
  project: string; agent: string; onCreated: (job: AgentJob) => void;
}) {
  const mutation = useCreateTask(project, () => {}), draft = useTaskChatDraft(project, `new:${agent}`);
  const client = useQueryClient();
  const input = useRef<ChatInputHandle>(null);
  const [sending, setSending] = useState<OperatorMessage>();
  useEffect(() => {
    if (document.activeElement === document.body && matchMedia("(min-width: 64rem) and (pointer: fine)").matches) input.current?.focus();
  }, []);
  return <TaskChatView presentation="page" onRetry={() => {}} draftError={draft.error}
    data={sending ? { task: { id: sending.id, title: "", agent, status: "incoming", prompt: "",
      interaction: { messages: [sending] } }, entries: [], available: false, limited: false, nextBefore: null,
      cursor: 0, canSend: true, readOnlyReason: "" } : undefined}
    welcome={sending ? undefined : <Stack gap={2}><Text asChild variant="heading"><h2>What would you like to work on?</h2></Text>
      <Text tone="secondary">Send a message to start a conversation with {agent}.</Text></Stack>}
    composer={{ ref: input, label: "Message agent", placeholder: `Message ${agent}...`,
      initialMarkdown: draft.initialMarkdown, onDraftChange: draft.onDraftChange,
      onSubmit: async (submission, signal) => {
        const title = conversationTitle(submission.markdown);
        const createdAt = submission.createdAt ?? new Date().toISOString();
        setSending({ id: submission.id, text: submission.markdown, status: "sending", created_at: createdAt });
        let task;
        try { task = await mutation.mutateAsync({ title, agent, prompt: submission.markdown }); }
        catch (error) { setSending(undefined); throw error; }
        if (signal.aborted) return;
        client.setQueryData<TaskConversation>(["task-conversation", project, task.id], {
          task: { id: task.id, title, agent, status: "incoming", prompt: submission.markdown, createdAt },
          entries: [], available: false, limited: false, nextBefore: null, cursor: 0, raw: true, logId: null,
          canSend: false, readOnlyReason: task.notice, activity: "queued",
        });
        draft.accepted(submission);
        onCreated({ id: task.id, key: `incoming:${task.id}.json`, agent, title, status: "incoming",
          archived: false, updatedAt: new Date().toISOString(), activity: "pending" });
      } }} />;
}
