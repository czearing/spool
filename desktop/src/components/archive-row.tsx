import { Slot } from "radix-ui";
import type { ReactElement } from "react";
import { useWorkItemDrag } from "../hooks/use-work-item-drag";
import type { WorkItem } from "../lib/work-items";
import styles from "./board.module.css";

export function ArchiveRow({ item, children }: { item: WorkItem; children: ReactElement }) {
  const { attributes, listeners, setNodeRef, isDragging } = useWorkItemDrag(item, "row");
  return (
    <Slot.Root ref={setNodeRef} id={`work-item-${item.id}`} className={`${styles.draggable} ${styles.archiveRow}`}
      data-dragging={isDragging} {...attributes} {...listeners}>{children}</Slot.Root>
  );
}
