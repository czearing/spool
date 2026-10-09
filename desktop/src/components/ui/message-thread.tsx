"use client";

import { memo, type ReactNode } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { ArrowDown } from "lucide-react";
import { Button } from "./button";
import { Text } from "./text";
import { Stack } from "./stack";
import styles from "./messaging/message-thread.module.css";

export const MessageThread = memo(function MessageThread({ children, label = "Messages", empty = false }: {
  children: ReactNode; label?: string; empty?: boolean;
}) {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({ initial: "instant", resize: "instant" });
  return <div className={styles.thread}>
    <section className={styles.viewport} ref={scrollRef} aria-label={label} tabIndex={0}>
      <Stack gap={6} className={styles.messages} ref={contentRef}>
        {empty ? <Text tone="muted">Start a conversation. Your messages stay in this preview.</Text> : children}
      </Stack>
    </section>
    {!isAtBottom && <Stack asChild direction="row" align="center" gap={2}><Button className={styles.latest} onClick={() => void scrollToBottom("instant")}>
      <ArrowDown aria-hidden /> Latest messages
    </Button></Stack>}
  </div>;
});
