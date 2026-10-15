"use client";

import { useCallback, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { $getRoot, type EditorState } from "lexical";
import type { TaskConversation } from "../lib/task-conversation";
import { conversationItems } from "../lib/conversation-tools";
import { ChatInput, type ChatSubmission } from "./ui/chat-input";
import { TaskConversationThread, type TaskConversationThreadHandle } from "./task-conversation-thread";
import { Button } from "./ui/button";
import { Text } from "./ui/text";
import { Stack } from "./ui/stack";
import { Grid } from "./ui/grid";
import styles from "./task-chat.module.css";

export function TaskChatView({ data, error, onLoadOlder, loadingOlder, onRetry, composer, draftError, presentation = "dialog", welcome, recovery }: {
  data?: TaskConversation; error?: string; onLoadOlder?: () => void; loadingOlder?: boolean; onRetry: () => void;
  composer: ComponentProps<typeof ChatInput>; draftError?: string;
  presentation?: "dialog" | "page"; welcome?: ReactNode; recovery?: ReactNode;
}) {
  const items = useMemo(() => data ? conversationItems(data) : [], [data]);
  const [hasDraft, setHasDraft] = useState(!!composer.initialMarkdown?.trim());
  const thread = useRef<TaskConversationThreadHandle>(null);
  const { onDraftChange, onSubmit } = composer;
  const submit = useCallback((submission: ChatSubmission, signal: AbortSignal) => {
    thread.current?.scrollToEnd();
    return onSubmit(submission, signal);
  }, [onSubmit]);
  const draftChanged = useCallback((state: EditorState) => {
    setHasDraft(state.read(() => !!$getRoot().getTextContent().trim())); onDraftChange?.(state);
  }, [onDraftChange]);
  const unavailable = welcome ? "" : error ? "Conversation unavailable."
    : !data ? "Loading conversation..." : data.readOnlyReason;
  return <Stack gap={0} justify={welcome ? "center" : "start"} className={`${styles.conversation} ${presentation === "page" ? styles.page : ""}`} data-welcome={!!welcome}>
    {error && <Stack direction="row" align="center" justify="space-between" gap={2} className={styles.feedback}><Text role="alert">{error}</Text><Button onClick={onRetry}>Retry</Button></Stack>}
    {welcome ? <div className={styles.welcome}>{welcome}</div> :
      <div className={styles.thread}><TaskConversationThread ref={thread} key={data?.logId ?? "initial"} items={items} hasMore={data?.nextBefore != null}
        loading={!data && !error} loadingOlder={loadingOlder} onLoadOlder={onLoadOlder} /></div>}
    <Grid gap={2} className={styles.composer}>
      {recovery}
      <ChatInput {...composer} onSubmit={submit} onDraftChange={draftChanged} placeholder={unavailable || composer.placeholder || "Message agent..."}
        disabled={composer.disabled || (!welcome && !data?.canSend) || !!error} />
      {hasDraft && unavailable && <Text role="status" variant="meta" tone="muted">{unavailable}</Text>}
      {draftError && <Text role="alert">{draftError}</Text>}
    </Grid>
  </Stack>;
}
