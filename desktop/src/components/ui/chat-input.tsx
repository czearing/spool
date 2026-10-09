"use client";

import { memo, useCallback, useRef, useState, type Ref } from "react";
import { configExtension, defineExtension, type EditorState } from "lexical";
import { LexicalExtensionComposer } from "@lexical/react/LexicalExtensionComposer";
import { RichTextExtension } from "@lexical/rich-text";
import { HistoryExtension } from "@lexical/history";
import { ListExtension } from "@lexical/list";
import { LinkExtension, AutoLinkExtension, autoLinkUrlMatcher, autoLinkEmailMatcher } from "@lexical/link";
import { CodeExtension } from "@lexical/code-core";
import { safeEditorUrl } from "./editor/urls";
import { Text } from "./text";
import { ChatComposer } from "./messaging/chat-composer";
import { $importChatMarkdown, chatNodes } from "./messaging/chat-markdown";
import { chatTheme } from "./messaging/chat-theme";
import styles from "./messaging/chat-input.module.css";

export type ChatSubmission = { id: string; markdown: string };
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
  const [extension] = useState(() => defineExtension({
    name: "spool/chat-input", namespace: "spool/chat-input", nodes: chatNodes, theme: chatTheme,
    editable: !props.disabled, onError: reportError, $initialEditorState: () => $importChatMarkdown(initialMarkdown),
    dependencies: [RichTextExtension, HistoryExtension, ListExtension, CodeExtension,
      configExtension(LinkExtension, { validateUrl: safeEditorUrl, attributes: { rel: "noopener noreferrer" } }),
      configExtension(AutoLinkExtension, { matchers: [autoLinkUrlMatcher, autoLinkEmailMatcher] })],
  }));
  return <div className={`${styles.container} ${className}`}>
    <LexicalExtensionComposer extension={extension} contentEditable={null}>
      <ChatComposer {...props} disabled={props.disabled || !!error} />
    </LexicalExtensionComposer>
    {error && <Text role="alert">Editing failed: {error} Your draft has not been reset.</Text>}
  </div>;
});
