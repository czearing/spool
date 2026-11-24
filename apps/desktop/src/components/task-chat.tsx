"use client";

import { memo, type ComponentProps } from "react";
import { useTaskConversation } from "../hooks/use-task-conversation";
import dynamic from "../platform/lazy";
import type TaskChatContentComponent from "./task-chat-content";
import { ContentPlaceholder } from "./ui/content-placeholder";

const TaskChatContent = dynamic(() => import("./task-chat-content"), {
  loading: () => <ContentPlaceholder label="Conversation" />,
});

export default memo(function TaskChat(props: Omit<ComponentProps<typeof TaskChatContentComponent>, "query">) {
  const query = useTaskConversation(props.project, props.task);
  return <TaskChatContent {...props} query={query} />;
});
