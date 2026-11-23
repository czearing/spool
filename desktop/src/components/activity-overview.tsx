"use client";

import { useState, type ReactNode } from "react";
import { History } from "lucide-react";
import { SidebarAction, SidebarGroup } from "./ui/sidebar";
import { ActivityHistory } from "./activity-history";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { Timestamp } from "./ui/timestamp";
import styles from "./agent-overview.module.css";

export type ActivityEntry = {
  id: string; title: string; status: string; tone: "danger" | "info" | "success" | "neutral";
  active?: boolean; archived?: boolean; updatedAt?: string | null;
};
export function ActivityOverview({ title, icon, entries, selected, onSelect, href, historyLabel, searchLabel,
  emptyLabel, historyAction, actions, children, historyFeedback, onArchive, archivePending, search: controlledSearch, onSearch }: {
  title: string; icon: ReactNode; entries: ActivityEntry[]; selected: string | null;
  onSelect: (id: string) => void; href: (id: string) => string;
  historyLabel: string; searchLabel: string; emptyLabel: string;
  historyAction?: { label: string; icon: ReactNode; onSelect: () => void }; actions?: ReactNode; children: ReactNode;
  historyFeedback?: ReactNode;
  onArchive?: (id: string, archived: boolean) => void; archivePending?: boolean;
  search?: string; onSearch?: (search: string) => void;
}) {
  const [localSearch, setLocalSearch] = useState(""), [open, setOpen] = useState(false);
  const search = controlledSearch ?? localSearch, setSearch = onSearch ?? setLocalSearch;
  const current = entries.find(entry => entry.id === selected);
  const history = <ActivityHistory entries={entries} selected={selected} href={href} label={historyLabel}
    search={search} emptyLabel={emptyLabel} feedback={historyFeedback} onArchive={onArchive} pending={archivePending}
    onSelect={id => { setOpen(false); onSelect(id); }}
    header={<Stack gap={3}>{historyAction && <SidebarGroup>
      <SidebarAction icon={historyAction.icon} onClick={() => { setOpen(false); historyAction.onSelect(); }}>
        {historyAction.label}
      </SidebarAction>
    </SidebarGroup>}
      <Input label={searchLabel} labelHidden placeholder={searchLabel} type="search" density="compact"
        value={search} onChange={event => setSearch(event.target.value)} /></Stack>} />;
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
