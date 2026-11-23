import { useDraggable } from "@dnd-kit/core";
import type { WorkItem } from "../lib/work-items";

export function useWorkItemDrag(item: WorkItem, role: "button" | "row" = "button") {
  return useDraggable({
    id: item.id,
    data: { status: item.status, title: item.title, archived: Boolean(item.archived) },
    attributes: { role },
  });
}
