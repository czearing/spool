"use client";

import { useState, type ReactNode } from "react";
import { History } from "lucide-react";
import { Sidebar, SidebarAction, SidebarGroup, SidebarItem } from "./ui/sidebar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Stack } from "./ui/stack";
import { StatusDot } from "./ui/status-dot";
import { Text } from "./ui/text";
import { Timestamp } from "./ui/timestamp";
import styles from "./agent-overview.module.css";

export type ActivityEntry = {
  id: string; title: string; status: string; tone: "danger" | "info" | "success" | "neutral";
  active?: boolean; updatedAt?: string | null;
};
export function ActivityOverview({ title, icon, entries, selected, onSelect, href, historyLabel, searchLabel,
  emptyLabel, historyAction, actions, children }: {
  title: string; icon: ReactNode; entries: ActivityEntry[]; selected: string | null;
  onSelect: (id: string) => void; href: (id: string) => string;
  historyLabel: string; searchLabel: string; emptyLabel: string;
  historyAction?: { label: string; icon: ReactNode; onSelect: () => void }; actions?: ReactNode; children: ReactNode;
}) {
  const [search, setSearch] = useState(""), [open, setOpen] = useState(false);
  const current = entries.find(entry => entry.id === selected);
  const matches = entries.filter(entry => entry.title.toLowerCase().includes(search.trim().toLowerCase()));
  const history = <Sidebar label={historyLabel} className={styles.history}
    header={<Stack gap={3}>{historyAction && <SidebarGroup>
      <SidebarAction icon={historyAction.icon} onClick={() => { setOpen(false); historyAction.onSelect(); }}>
        {historyAction.label}
      </SidebarAction>
    </SidebarGroup>}
      <Input label={searchLabel} labelHidden placeholder={searchLabel} type="search" density="compact"
        value={search} onChange={event => setSearch(event.target.value)} /></Stack>}>
    <SidebarGroup label={historyLabel}>
      {matches.map(entry => <SidebarItem key={entry.id} href={href(entry.id)}
        active={entry.id === selected} title={entry.title} aria-label={entry.title} data-work-item-id={entry.id}
        onClick={event => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); setOpen(false); onSelect(entry.id);
        }}>
        <Stack gap={1}><span className={styles.title}>{entry.title}</span>
          <Stack direction="row" align="center" gap={2}>
            <StatusDot tone={entry.tone} pulse={entry.active} />
            <Text variant="meta" tone="muted">{entry.status}</Text>
          </Stack>
        </Stack>
      </SidebarItem>)}
      {!matches.length && <li className={styles.empty}><Text variant="meta" tone="muted">
        {search ? `No matching ${historyLabel.toLowerCase()}.` : emptyLabel}
      </Text></li>}
    </SidebarGroup>
  </Sidebar>;
  return <Stack asChild direction="row" gap={0}><main className={styles.page}>
    <div className={styles.desktop}>{history}</div>
    <Stack gap={0} className={styles.content}>
      <Stack asChild direction="row" align="center" justify="space-between" gap={3}><header className={styles.header}>
        <Stack direction="row" align="center" gap={2} className={styles.identity}>
          <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild>
            <Button className={styles.mobile} aria-label={`Open ${historyLabel.toLowerCase()}`}><History aria-hidden /></Button>
          </PopoverTrigger><PopoverContent label={`${historyLabel} history`} density="compact" align="start" className={styles.popup}>
            <div className={styles.mobileHistory}>{history}</div>
          </PopoverContent></Popover>
          {icon}<Text asChild variant="heading"><h1 className={styles.heading}>{title}</h1></Text>
        </Stack>
        {actions}
      </header></Stack>
      {current && <Stack direction="row" align="center" justify="space-between" gap={3} className={styles.subject}>
        <Text className={styles.title} title={current.title}>{current.title}</Text>
        {current.updatedAt && <Text variant="meta" tone="muted" className={styles.date}>
          <Timestamp value={current.updatedAt} timeZone="local" />
        </Text>}
      </Stack>}
      <div className={styles.chat}>{children}</div>
    </Stack>
  </main></Stack>;
}
