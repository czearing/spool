import { useDroppable } from "@dnd-kit/core";
import type { WorkItem } from "../lib/work-items";
import { WorkItemCard } from "./work-item-card";
import { DropIndicator } from "./ui/drop-indicator";
import styles from "./board.module.css";

export function BoardItem({ item, sorted }: { item: WorkItem; sorted: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `item:${item.id}`, disabled: sorted, data: { itemId: item.id, status: item.status } });
  return <li ref={setNodeRef} className={styles.item} data-insertion={isOver}>
    {isOver && <DropIndicator />}<WorkItemCard item={item} />
  </li>;
}
