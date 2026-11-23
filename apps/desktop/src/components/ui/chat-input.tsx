"use client";

import { memo, useCallback, useRef, useState, type Ref } from "react";
import type { EditorState } from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { AutoLinkPlugin } from "@lexical/react/LexicalAutoLinkPlugin";
import { autoLinkUrlMatcher, autoLinkEmailMatcher } from "@lexical/link";
import { CodeHighlightNode } from "@lexical/code-core";
import { safeEditorUrl } from "./editor/urls";
import { Text } from "./text";
import { ChatComposer } from "./messaging/chat-composer";
import { $importChatMarkdown, chatNodes } from "./messaging/chat-markdown";
import { chatTheme } from "./messaging/chat-theme";
import styles from "./messaging/chat-input.module.css";

const linkAttributes = { rel: "noopener noreferrer" };
const linkMatchers = [autoLinkUrlMatcher, autoLinkEmailMatcher];

export type ChatSubmission = { id: string; markdown: string; createdAt?: string };
export type ChatInputHandle = { focus: () => void; getMarkdown: () => string };
export type ChatInputProps = {
  label: string; placeholder?: string; initialMarkdown?: string; disabled?: boolean;
  onSubmit: (submission: ChatSubmission, signal: AbortSignal) => Promise<void>;
  onStop?: () => void;
  onDraftChange?: (state: EditorState) => void;
  onError?: (error: Error) => void;
  ref?: Ref<ChatInputHandle>; className?: string;
};

export const ChatInput = memo(function ChatInput({ initialMarkdown = "", onError, className = "", ...props }: ChatInputProps) {
  const [error, setError] = useState("");
  const errorCallback = useRef(onError); errorCallback.current = onError;
  const reportError = useCallback((cause: Error) => {
    console.error(cause); setError(cause.message); errorCallback.current?.(cause);
  }, []);
  const [config] = useState(() => ({
    namespace: "spool/chat-input", nodes: [...chatNodes, CodeHighlightNode], theme: chatTheme,
    editable: !props.disabled, onError: reportError, editorState: () => $importChatMarkdown(initialMarkdown),
  }));
  return <div className={`${styles.container} ${className}`}>
    {/* Plugin effects reconnect when retained chats reappear without disposing the editor. */}
    <LexicalComposer initialConfig={config}>
      <HistoryPlugin />
      <ListPlugin />
      <LinkPlugin validateUrl={safeEditorUrl} attributes={linkAttributes} />
      <AutoLinkPlugin matchers={linkMatchers} />
      <ChatComposer {...props} disabled={props.disabled || !!error} />
    </LexicalComposer>
    {error && <Text role="alert">Editing failed: {error} Your draft has not been reset.</Text>}
  </div>;
});
