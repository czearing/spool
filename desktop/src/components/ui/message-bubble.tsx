"use client";

import { memo, useMemo, useState } from "react";
import { Bot, Check, CircleAlert, Copy } from "lucide-react";
import { Button } from "./button";
import { Text } from "./text";
import { Stack } from "./stack";
import { Grid } from "./grid";
import { MessageContent } from "./messaging/message-content";
import { Tooltip, TooltipProvider } from "./tooltip";
import styles from "./messaging/message-bubble.module.css";

export type MessageStatus = "sending" | "accepted" | "generating" | "complete" | "stopped" | "failed";
export type MessageBubbleProps = {
  author: string; markdown: string; direction?: "incoming" | "outgoing"; status?: MessageStatus;
  error?: string; onRetry?: () => void; className?: string; createdAt?: string; statusLabel?: string;
};
const labels: Record<MessageStatus, string> = {
  sending: "Sending", accepted: "Accepted", generating: "Generating", complete: "", stopped: "Stopped", failed: "Failed",
};
const fullTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
});
const shortTime = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

export const MessageBubble = memo(function MessageBubble({ author, markdown, direction = "incoming", status = "complete",
  error, onRetry, className = "", createdAt, statusLabel }: MessageBubbleProps) {
  const [copied, setCopied] = useState<string | null>(null), [copyError, setCopyError] = useState("");
  const label = statusLabel ?? labels[status];
  const timestamp = useMemo(() => {
    if (!createdAt) return;
    const date = new Date(createdAt);
    if (Number.isFinite(date.getTime())) return { title: fullTime.format(date), text: shortTime.format(date) };
  }, [createdAt]);
  async function copy() {
    try { await navigator.clipboard.writeText(markdown); setCopied(markdown); setCopyError(""); }
    catch (cause) { setCopyError(`Could not copy: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  return <Grid asChild gap={2}><article className={`${styles.message} ${className}`} data-direction={direction} data-status={status} aria-label={`${author} message`}>
    <Stack direction="row" align="center" justify={direction === "outgoing" ? "end" : "start"} gap={2} wrap>
      {direction === "incoming" && <Bot className={styles.avatar} aria-hidden />}
      <Text variant="action">{author}</Text>
      {timestamp && <Text asChild variant="meta" tone="muted">
        <time dateTime={createdAt} title={timestamp.title}>{timestamp.text}</time>
      </Text>}
    </Stack>
    <div className={styles.body}><MessageContent markdown={markdown} streaming={status === "generating"} reading={direction === "incoming"} /></div>
    <Stack direction="row" align="center" justify={direction === "outgoing" ? "end" : "start"} gap={2} className={styles.actions}>
      {label && <Text variant="meta" tone={status === "failed" ? undefined : "muted"} className={status === "failed" ? styles.failureStatus : undefined}>
        {status === "failed" && <CircleAlert aria-hidden="true" />}{label}
      </Text>}
      {markdown && <TooltipProvider><Tooltip content={copied === markdown ? "Copied" : "Copy message"}>
        <Button className={styles.copy} onClick={() => void copy()} aria-label={`Copy ${author} message`}>
        {copied === markdown ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span className={styles.srOnly} role="status">{copied === markdown ? "Copied" : ""}</span>
      </Button></Tooltip></TooltipProvider>}
      {status === "failed" && onRetry && <Button onClick={onRetry}>Retry</Button>}
    </Stack>
    {error && <Text role="alert" className={styles.error}>{error}</Text>}
    {copyError && <Text role="alert">{copyError}</Text>}
  </article></Grid>;
});
