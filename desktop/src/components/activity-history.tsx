"use client";

import { memo, useMemo, type ReactNode } from "react";
import { DndContext, DragOverlay, useDndContext, useDraggable, useDroppable } from "@dnd-kit/core";
import { useActivityDrag } from "../hooks/use-activity-drag";
import type { ActivityEntry } from "./activity-overview";
import { Sidebar, SidebarAccordion, SidebarGroup, SidebarItem } from "./ui/sidebar";
import { Card } from "./ui/card";
import { Stack } from "./ui/stack";
import { StatusDot } from "./ui/status-dot";
import { Text } from "./ui/text";
import { useNavigationPrefetch } from "../platform/navigation";
import styles from "./agent-overview.module.css";

const HistoryEntry = memo(function HistoryEntry({ id, title, status, tone, active, archived, selected, href, draggable }:
  Pick<ActivityEntry, "id" | "title" | "status" | "tone" | "active" | "archived"> & {
    selected: boolean; href: string; draggable: boolean;
  }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id, data: { archived: Boolean(archived) }, disabled: !draggable, attributes: { role: "link" },
  });
  const intent = useNavigationPrefetch(href);
  return <SidebarItem ref={setNodeRef} href={href} active={selected} title={title} aria-label={title}
    data-work-item-id={id} draggable={false} data-dragging={isDragging}
    className={draggable ? styles.draggable : undefined} {...(draggable ? attributes : {})} {...listeners}
    onPointerEnter={intent.start} onPointerLeave={intent.cancel} onFocus={intent.run}>
    <Stack gap={1}><span className={styles.title}>{title}</span>
      <Stack direction="row" align="center" gap={2}>
        <StatusDot tone={tone} pulse={active} />
        <Text variant="meta" tone="muted">{status}</Text>
      </Stack>
    </Stack>
  </SidebarItem>;
});
function HistoryGroup({ archived = false, label, defaultOpen, enabled, children }: {
  archived?: boolean; label: string; defaultOpen?: boolean; enabled: boolean; children: ReactNode;
}) {
  const { active } = useDndContext();
  const { setNodeRef, isOver } = useDroppable({ id: archived ? "archive" : "conversations", disabled: !enabled });
  const props = { ref: setNodeRef, label, className: styles.dropTarget, tabIndex: enabled ? -1 : undefined, "data-archive": archived,
    "data-over": isOver && !!active && Boolean(active.data.current?.archived) !== archived };
  return archived ? <SidebarAccordion {...props} defaultOpen={defaultOpen}>{children}</SidebarAccordion>
    : <SidebarGroup {...props}>{children}</SidebarGroup>;
}
export function ActivityHistory({ entries, selected, onSelect, href, label, search, header, feedback, emptyLabel, onArchive, pending }: {
  entries: ActivityEntry[]; selected: string | null; onSelect: (id: string) => void; href: (id: string) => string;
  label: string; search: string; header: ReactNode; feedback?: ReactNode; emptyLabel: string;
  onArchive?: (id: string, archived: boolean) => void; pending?: boolean;
}) {
  const drag = useActivityDrag(entries, onArchive), enabled = !!onArchive && !pending;
  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? entries.filter(entry => entry.title.toLowerCase().includes(query)) : entries;
  }, [entries, search]);
  const archived = matches.filter(entry => entry.archived);
  const renderEntry = (entry: ActivityEntry) => <HistoryEntry key={entry.id} id={entry.id} title={entry.title}
    status={entry.status} tone={entry.tone} active={entry.active} archived={entry.archived} selected={entry.id === selected}
    href={href(entry.id)} draggable={enabled} />;
  return <DndContext {...drag.context}><Sidebar label={label} className={styles.history} header={header}
    onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-work-item-id]") : null;
      if (!link || !event.currentTarget.contains(link)) return;
      event.preventDefault(); onSelect(link.dataset.workItemId!);
    }}>
    <HistoryGroup label={label} enabled={enabled}>
      {matches.filter(entry => !entry.archived).map(renderEntry)}
      {feedback && <li className={styles.empty}>{feedback}</li>}
      {!matches.length && !feedback && <li className={styles.empty}><Text variant="meta" tone="muted">
        {search ? `No matching ${label.toLowerCase()}.` : emptyLabel}
      </Text></li>}
    </HistoryGroup>
    {(!!archived.length || !!drag.active) && <HistoryGroup archived label="Archive" enabled={enabled}
      defaultOpen={archived.some(entry => entry.id === selected)}>{archived.map(renderEntry)}</HistoryGroup>}
  </Sidebar><DragOverlay dropAnimation={null}>{drag.active && <Card className={styles.dragPreview}>
    <Text variant="action" className={styles.title}>{drag.active.title}</Text>
  </Card>}</DragOverlay></DndContext>;
}
