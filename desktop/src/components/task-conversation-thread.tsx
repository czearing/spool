"use client";

import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import type { ConversationItem } from "../lib/conversation-tools";
import { MessageBubble } from "./ui/message-bubble";
import { TaskToolCall } from "./task-tool-call";
import { Button } from "./ui/button";
import { Text } from "./ui/text";
import { Stack } from "./ui/stack";
import styles from "./task-chat.module.css";

export type TaskConversationThreadHandle = { scrollToEnd: () => void };
export function TaskConversationThread({ items, cursor, nextBefore, loadingOlder, onLoadOlder, loading, ref }: {
  items: ConversationItem[]; cursor: number; nextBefore: number | null;
  loadingOlder?: boolean; onLoadOlder?: () => void; loading?: boolean;
  ref?: Ref<TaskConversationThreadHandle>;
}) {
  const viewport = useRef<HTMLElement>(null), initialized = useRef(false), scrollTop = useRef(0);
  const previousWindow = useRef({ cursor }), hasMore = nextBefore !== null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const getItemKey = useCallback((index: number) => items[index].id, [items]);
  const virtual = useVirtualizer({
    count: items.length, getScrollElement: () => viewport.current, getItemKey,
    estimateSize: index => items[index].kind === "tool" ? 64 : 160,
    anchorTo: "end", followOnAppend: true, scrollEndThreshold: 80, overscan: 4,
  });
  useImperativeHandle(ref, () => ({ scrollToEnd() {
    virtual.scrollToEnd(); scrollTop.current = viewport.current?.scrollTop ?? 0;
  } }), [virtual]);
  useLayoutEffect(() => {
    const previous = previousWindow.current;
    if (items.length && (!initialized.current || cursor < previous.cursor ||
        nextBefore !== null && nextBefore > previous.cursor)) {
      initialized.current = true;
      virtual.scrollToEnd();
      scrollTop.current = viewport.current?.scrollTop ?? 0;
    }
    previousWindow.current = { cursor };
  }, [cursor, items.length, nextBefore, virtual]);
  return <div className={styles.virtualThread}>
    {hasMore && onLoadOlder && <Button className={styles.earlier} disabled={loadingOlder} onClick={onLoadOlder}>
      {loadingOlder ? "Loading earlier messages..." : "Load earlier messages"}
    </Button>}
    <section ref={viewport} className={styles.virtualViewport} aria-label="Task conversation" tabIndex={0}
      onScroll={event => {
        const next = event.currentTarget.scrollTop, previous = scrollTop.current;
        scrollTop.current = next;
        if (initialized.current && next < previous && next < 240 && hasMore && !loadingOlder) onLoadOlder?.();
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
