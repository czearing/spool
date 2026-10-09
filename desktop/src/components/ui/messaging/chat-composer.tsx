import { useCallback, useEffect, useId, useImperativeHandle, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { LoaderCircle, RotateCcw, Square } from "lucide-react";
import type { ChatInputProps } from "../chat-input";
import { Button } from "../button";
import { Text } from "../text";
import { Stack } from "../stack";
import { Tooltip, TooltipProvider } from "../tooltip";
import { Toolbar, ToolbarButton } from "../toolbar";
import { $exportChatMarkdown, chatTransformers } from "./chat-markdown";
import { ChatBehavior } from "./chat-behavior";
import { useChatSubmit } from "./use-chat-submit";
import { ChatFormatting } from "./chat-formatting";
import content from "./message-content.module.css";
import styles from "./chat-input.module.css";

export function ChatComposer({ ref, label, placeholder = "Write a message...", ...props }: ChatInputProps) {
  const [editor] = useLexicalComposerContext();
  const { submit, pending, empty, error, canRetry } = useChatSubmit(editor, { ...props, label });
  const [pasteError, setPasteError] = useState("");
  const reportPasteError = useCallback((error: Error) => setPasteError(error.message), []);
  const hint = useId(), feedback = useId();
  useEffect(() => { editor.setEditable(!props.disabled); }, [editor, props.disabled]);
  useImperativeHandle(ref, () => ({ focus: () => editor.focus(), getMarkdown: () => editor.read($exportChatMarkdown) }), [editor]);
  const actionLabel = pending ? "Sending message" : props.onStop ? "Stop response" : canRetry ? "Retry sending message" : "Send message";
  const actionHint = pending ? "Waiting for acceptance" : props.onStop ? "Stop response" : `${actionLabel} (Enter)`;
  return <TooltipProvider delayDuration={400}><form className={styles.form} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <Stack gap={2} className={styles.surface} data-disabled={props.disabled || undefined} onClick={(event) => {
      if (event.target === event.currentTarget && !props.disabled) editor.focus();
    }}>
      <div className={styles.field}>
        <ContentEditable className={`${content.content} ${styles.editable}`} aria-label={label} aria-disabled={props.disabled} aria-multiline
          aria-describedby={`${hint} ${feedback}`} aria-placeholder={placeholder}
          placeholder={<div className={styles.placeholder}>{placeholder}</div>} />
      </div>
      <Toolbar className={styles.actions} density="compact" aria-label="Message actions">
        <ChatFormatting editor={editor} disabled={props.disabled} />
        <Text className={styles.status} role="status" variant="meta" tone="muted">{pending ? "Sending..." : ""}</Text>
        <Tooltip content={actionHint}>
          <ToolbarButton asChild><Button type={props.onStop ? "button" : "submit"} variant="primary"
            onClick={() => { props.onStop?.(); editor.focus(); }}
            disabled={props.disabled || pending || (!props.onStop && empty)} aria-label={actionLabel}>
            {pending ? <LoaderCircle aria-hidden className={styles.spinner} /> : props.onStop ? <Square aria-hidden />
              : canRetry ? <RotateCcw aria-hidden /> : null}
            {props.onStop ? "Stop" : canRetry ? "Retry" : "Send"}
          </Button></ToolbarButton>
        </Tooltip>
      </Toolbar>
    </Stack>
    <span id={hint} className={styles.srOnly}>Enter to send. Shift+Enter for a new line.</span>
    <div id={feedback} className={styles.feedback}>
      {error && <Text role="alert">Could not confirm send: {error} Your draft is still here.</Text>}
      {pasteError && <Text role="alert">{pasteError}</Text>}
    </div>
    <ChatBehavior editor={editor} submit={submit} reportError={reportPasteError} />
    <MarkdownShortcutPlugin transformers={chatTransformers} />
  </form></TooltipProvider>;
}
