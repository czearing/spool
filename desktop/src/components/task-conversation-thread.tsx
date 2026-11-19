"use client";

import { memo, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import type { ConversationItem } from "../lib/conversation-tools";
import { MessageBubble } from "./ui/message-bubble";
import { TaskToolCall } from "./task-tool-call";
import { Button } from "./ui/button";
import { Text } from "./ui/text";
import { Stack } from "./ui/stack";
import { ContentPlaceholder } from "./ui/content-placeholder";
import styles from "./task-chat.module.css";

export type TaskConversationThreadHandle = { scrollToEnd: () => void };
export const TaskConversationThread = memo(function TaskConversationThread({ items, cursor, logId, nextBefore, loadingOlder, onLoadOlder, loading, messageRetries, ref }: {
  items: ConversationItem[]; cursor: number; logId?: string | null; nextBefore: number | null;
  loadingOlder?: boolean; onLoadOlder?: () => void; loading?: boolean;
  messageRetries?: ReadonlyMap<string, () => void>;
  ref?: Ref<TaskConversationThreadHandle>;
}) {
  const viewport = useRef<HTMLElement>(null), initialized = useRef(false), scrollTop = useRef(0);
  const previousItems = useRef(new Set<string>());
  const previousWindow = useRef({ cursor, logId }), hasMore = nextBefore !== null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showLatest, setShowLatest] = useState(false);
  const changed = useCallback((instance: Virtualizer<HTMLElement, Element>) => {
    const distance = instance.scrollRect ? instance.getTotalSize() - instance.scrollRect.height - (instance.scrollOffset ?? 0) : 0;
    setShowLatest(distance > instance.options.scrollEndThreshold);
  }, []);
  const toolOpenChanged = useCallback((id: string, open: boolean) => setExpanded(previous => {
    const next = new Set(previous), key = `tool:${id}`;
    if (open) next.add(key); else next.delete(key);
    return next;
  }), []);
  const getItemKey = useCallback((index: number) => items[index].id, [items]);
  const virtual = useVirtualizer({
    count: items.length, getScrollElement: () => viewport.current, getItemKey,
    estimateSize: index => items[index].kind === "tool" ? 64 : 160,
    // Follow only at the bottom, not after a deliberate small upward scroll.
    anchorTo: "end", followOnAppend: true, scrollEndThreshold: 1, overscan: 4,
    directDomUpdates: true, onChange: changed,
  });
  useImperativeHandle(ref, () => ({ scrollToEnd: () => virtual.scrollToEnd() }), [virtual]);
  useLayoutEffect(() => {
    const previous = previousWindow.current;
    const replaced = logId !== previous.logId || cursor < previous.cursor ||
      nextBefore !== null && nextBefore > previous.cursor;
    if (items.length && (!initialized.current || replaced || !items.some(item => previousItems.current.has(item.id)))) {
      initialized.current = true;
      virtual.scrollToEnd();
      scrollTop.current = viewport.current?.scrollTop ?? 0;
    }
    previousItems.current = new Set(items.map(item => item.id));
    previousWindow.current = { cursor, logId };
  }, [cursor, items, logId, nextBefore, virtual]);
  return <div className={styles.virtualThread}>
    {hasMore && onLoadOlder && <Button className={styles.earlier} disabled={loadingOlder} onClick={onLoadOlder}>
      {loadingOlder ? "Loading earlier messages..." : "Load earlier messages"}
    </Button>}
    <section ref={viewport} className={styles.virtualViewport} aria-label="Task conversation" aria-busy={!!loading || !!loadingOlder} tabIndex={0}
      onScroll={event => {
        const next = event.currentTarget.scrollTop, previous = scrollTop.current;
        scrollTop.current = next;
        if (initialized.current && next < previous && next < 240 && hasMore && !loadingOlder) onLoadOlder?.();
      }}>
      <div ref={virtual.containerRef} role="list" aria-label="Conversation messages" className={styles.virtualItems}
        data-message-count={items.length} data-has-more={hasMore}>
        {virtual.getVirtualItems().map(row => {
          const item = items[row.index];
          return <div key={row.key} ref={virtual.measureElement} data-index={row.index} data-message-id={item.id}
            role="listitem" aria-posinset={row.index + 1} aria-setsize={items.length} className={styles.virtualRow}>
            {item.kind === "error" ? <Text role="alert">{item.text}</Text> : item.kind === "message" ? <MessageBubble {...item.message} onRetry={messageRetries?.get(item.id)} /> :
              <TaskToolCall tool={item.tool} open={expanded.has(item.id)} onOpenChange={toolOpenChanged} />}
          </div>;
        })}
      </div>
      {loading && <ContentPlaceholder label="Conversation" />}
    </section>
    {items.length > 0 && showLatest && <Button className={styles.latest} onClick={() => virtual.scrollToEnd()}>
      <Stack direction="row" align="center" gap={2}><ArrowDown aria-hidden />Latest messages</Stack>
    </Button>}
  </div>;
});
