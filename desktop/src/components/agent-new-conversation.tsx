"use client";

import { useEffect, useRef } from "react";
import { useCreateTask } from "../hooks/use-create-task";
import { useTaskChatDraft } from "../hooks/use-task-chat-draft";
import { conversationTitle } from "../lib/agent-conversations";
import type { AgentJob } from "../lib/agent-jobs";
import type { ChatInputHandle } from "./ui/chat-input";
import { TaskChatView } from "./task-chat-view";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";

export default function AgentNewConversation({ project, agent, onCreated }: {
  project: string; agent: string; onCreated: (job: AgentJob) => void;
}) {
  const mutation = useCreateTask(project, () => {}), draft = useTaskChatDraft(project, `new:${agent}`);
  const input = useRef<ChatInputHandle>(null);
  useEffect(() => {
    if (document.activeElement === document.body && matchMedia("(min-width: 64rem) and (pointer: fine)").matches) input.current?.focus();
  }, []);
  return <TaskChatView presentation="page" onRetry={() => {}} draftError={draft.error}
    welcome={<Stack gap={2}><Text asChild variant="heading"><h2>What would you like to work on?</h2></Text>
      <Text tone="secondary">Send a message to start a conversation with {agent}.</Text></Stack>}
    composer={{ ref: input, label: "Message agent", placeholder: `Message ${agent}...`,
      initialMarkdown: draft.initialMarkdown, onDraftChange: draft.onDraftChange,
      onSubmit: async (submission, signal) => {
        const pending = draft.prepare(submission), title = conversationTitle(pending.markdown);
        const task = await mutation.mutateAsync({ title, agent, prompt: pending.markdown });
        if (signal.aborted) return;
        draft.accepted(pending);
        onCreated({ id: task.id, key: `incoming:${task.id}.json`, agent, title, status: "incoming",
          archived: false, updatedAt: new Date().toISOString() });
      } }} />;
}
