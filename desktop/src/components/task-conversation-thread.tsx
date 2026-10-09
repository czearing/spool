"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import type { ConversationItem } from "../lib/conversation-tools";
import { MessageBubble } from "./ui/message-bubble";
import { TaskToolCall } from "./task-tool-call";
import { Button } from "./ui/button";
import { Text } from "./ui/text";
import { Stack } from "./ui/stack";
import styles from "./task-chat.module.css";

export function TaskConversationThread({ items, hasMore, loadingOlder, onLoadOlder, loading }: {
  items: ConversationItem[]; hasMore: boolean; loadingOlder?: boolean; onLoadOlder?: () => void; loading?: boolean;
}) {
  const viewport = useRef<HTMLElement>(null), initialized = useRef(false), nearStart = useRef(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const getItemKey = useCallback((index: number) => items[index].id, [items]);
  const virtual = useVirtualizer({
    count: items.length, getScrollElement: () => viewport.current, getItemKey,
    estimateSize: index => items[index].kind === "tool" ? 64 : 160,
    anchorTo: "end", followOnAppend: true, scrollEndThreshold: 80, overscan: 4,
  });
  useLayoutEffect(() => {
    if (items.length && !initialized.current) { initialized.current = true; virtual.scrollToEnd(); }
  }, [items.length, virtual]);
  useEffect(() => {
    const element = viewport.current;
    if (initialized.current && hasMore && !loadingOlder && element &&
      (element.scrollHeight <= element.clientHeight || nearStart.current && element.scrollTop < 240)) onLoadOlder?.();
  }, [items.length, hasMore, loadingOlder, onLoadOlder, virtual]);
  return <div className={styles.virtualThread}>
    <section ref={viewport} className={styles.virtualViewport} aria-label="Task conversation" tabIndex={0}
      onScroll={event => {
        nearStart.current = event.currentTarget.scrollTop < 240;
        if (initialized.current && nearStart.current && hasMore && !loadingOlder) onLoadOlder?.();
      }}>
      <div role="list" aria-label="Conversation messages" className={styles.virtualItems} style={{ height: virtual.getTotalSize() }}
        data-message-count={items.length} data-has-more={hasMore}>
        {virtual.getVirtualItems().map(row => {
          const item = items[row.index];
          return <div key={row.key} ref={virtual.measureElement} data-index={row.index} data-message-id={item.id}
            role="listitem" aria-posinset={row.index + 1} aria-setsize={items.length} className={styles.virtualRow}
            style={{ transform: `translateY(${row.start}px)` }}>
            {item.kind === "error" ? <Text role="alert">{item.text}</Text> : item.kind === "message" ? <MessageBubble {...item.message} /> :
              <TaskToolCall tool={item.tool} open={expanded.has(item.id)} onOpenChange={open => setExpanded(previous => {
                const next = new Set(previous); if (open) next.add(item.id); else next.delete(item.id); return next;
              })} />}
          </div>;
        })}
      </div>
      {loading && <Text role="status" tone="muted" className={styles.feedback}>Loading conversation...</Text>}
    </section>
    {loadingOlder && <Text role="status" variant="meta" className={styles.historyLoading}>Loading history...</Text>}
    {items.length > 0 && !virtual.isAtEnd() && <Button className={styles.latest} onClick={() => virtual.scrollToEnd()}>
      <Stack direction="row" align="center" gap={2}><ArrowDown aria-hidden />Latest messages</Stack>
    </Button>}
  </div>;
}
