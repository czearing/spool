import { useDroppable } from "@dnd-kit/core";
import { labels, type WorkItem } from "../lib/work-items";
import { ArchiveSection } from "./archive-section";
import { List, type ListColumn } from "./ui/list";
import { Text } from "./ui/text";
import { ArchiveRow } from "./archive-row";
import type { ReactElement } from "react";
import { FileText } from "lucide-react";
import { ListCell } from "./ui/list-cell";

const columns: ListColumn<WorkItem>[] = [
  { key: "title", header: "Work item", icon: <FileText />, width: "72%", sortValue: (item) => item.title,
    cell: (item) => <ListCell icon={<FileText />}>{item.title}</ListCell> },
  { key: "status", header: "Status", sortValue: (item) => labels[item.status],
    cell: (item) => <Text tone="secondary">{labels[item.status]}</Text> },
];
const getRowKey = (item: WorkItem) => item.id;
const renderRow = (item: WorkItem, row: ReactElement) => <ArchiveRow item={item}>{row}</ArchiveRow>;

export function ArchiveTarget({ items }: { items: WorkItem[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: "archive" });
  return (
    <ArchiveSection ref={setNodeRef} tabIndex={-1} data-over={isOver} count={items.length}>
        <List label="Archived work items" items={items} columns={columns} getRowKey={getRowKey}
          emptyMessage="Drop items here." renderRow={renderRow} preferencesKey="archive" />
    </ArchiveSection>
  );
}
