import { useDndContext, useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { labels, type Status, type WorkItem } from "../lib/work-items";
import { BoardItem } from "./board-item";
import { BoardComposer } from "./board-composer";
import { Button } from "./ui/button";
import { Stack } from "./ui/stack";
import { BoardColumn } from "./board-view";
import { Tooltip } from "./ui/tooltip";
import { ColumnArchiveMenu } from "./column-archive-menu";
import styles from "./board.module.css";

export function BoardLane({ status, items, total, sorted, adding, disableAdd, onAdd, onCancel, onCreate, onArchive }: {
  status: Status; items: WorkItem[]; total: number; sorted: boolean; adding: boolean; disableAdd: boolean;
  onAdd: () => void; onCancel: () => void; onCreate: (title: string) => Promise<void>;
  onArchive: () => Promise<unknown>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, data: { status } });
  const { over } = useDndContext();
  return <BoardColumn ref={setNodeRef} tone={status} label={labels[status]} count={items.length} total={total}
    isOver={isOver || over?.data.current?.status === status}
    actions={<><Tooltip content={`Add task to ${labels[status]}`}><Stack asChild direction="row" align="center" justify="center" gap={2}><Button className={styles.addIcon}
      aria-label={`Add task to ${labels[status]}`} onClick={onAdd} disabled={disableAdd}><Plus aria-hidden="true" /></Button></Stack></Tooltip>
      {(status === "completed" || status === "blocked") && <ColumnArchiveMenu label={labels[status]} count={total} onArchive={onArchive} />}</>}
    footer={adding ? <BoardComposer statusLabel={labels[status]} onCreate={onCreate} onCancel={onCancel} />
        : <Stack asChild direction="row" align="center" gap={2}><Button id={`add-${status}`} className={styles.addRow} onClick={onAdd} disabled={disableAdd}
          aria-label={`New task in ${labels[status]}`}><Plus aria-hidden="true" />New task</Button></Stack>}>
    {items.map((item) => <BoardItem key={item.id} item={item} sorted={sorted} />)}
  </BoardColumn>;
}
