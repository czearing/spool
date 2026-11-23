"use client";

import { memo } from "react";
import { MessageBubble, type MessageBubbleProps } from "./message-bubble";
export type ChatMessage = MessageBubbleProps & { id: string };

export const MessageHistory = memo(function MessageHistory({ messages }: { messages: readonly ChatMessage[] }) {
  return messages.map(({ id, ...message }) => <MessageBubble key={id} {...message} />);
});
