"use client";

import { FileText } from "lucide-react";
import type { ArchivedSpoolItem } from "../lib/spool-archive";
import { spoolQueues } from "../lib/spool-model";
import { ArchiveSection } from "./archive-section";
import { List, type ListColumn } from "./ui/list";
import { ListCell } from "./ui/list-cell";
import { Text } from "./ui/text";
import { Timestamp } from "./ui/timestamp";

const labels = Object.fromEntries(spoolQueues.map(({ id, label }) => [id, label]));
const columns: ListColumn<ArchivedSpoolItem>[] = [
  { key: "title", header: "Work item", icon: <FileText />, width: "55%", sortValue: (item) => item.title,
    cell: (item) => <ListCell icon={<FileText />} description={item.id}>{item.title}</ListCell> },
  { key: "status", header: "Status", width: "20%", sortValue: (item) => labels[item.status],
    cell: (item) => <Text tone="secondary">{labels[item.status]}</Text> },
  { key: "updated", header: "Updated (UTC)", width: "25%", sortValue: (item) => item.updatedAt ? new Date(item.updatedAt) : undefined,
    cell: (item) => <Timestamp value={item.updatedAt} /> },
];
const getRowKey = (item: ArchivedSpoolItem) => item.key;
export function ArchivedTasks({ items }: { items: readonly ArchivedSpoolItem[] }) {
  return <ArchiveSection count={items.length} description="Archived tasks and previous attempts. Resumed tasks return to the board automatically.">
    <List label="Archived work items" items={items} columns={columns} getRowKey={getRowKey} virtualize
      emptyMessage="No archived work items." minWidth="var(--size-list)" maxHeight="var(--size-archive-max-height)" />
  </ArchiveSection>;
}
