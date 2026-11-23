import { memo } from "react";
import { useWorkItemDrag } from "../hooks/use-work-item-drag";
import type { WorkItem } from "../lib/work-items";
import { BoardCard } from "./board-view";
import { Text } from "./ui/text";
import styles from "./board.module.css";

export const WorkItemCard = memo(function WorkItemCard({ item }: { item: WorkItem }) {
  const { attributes, listeners, setNodeRef, isDragging } = useWorkItemDrag(item);
  return (
    <BoardCard asChild className={styles.draggable}>
      <button ref={setNodeRef} id={`work-item-${item.id}`} type="button"
        data-dragging={isDragging} {...attributes} {...listeners}>
        <Text variant="action">{item.title}</Text>
      </button>
    </BoardCard>
  );
});
