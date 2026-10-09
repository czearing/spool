import { memo, useLayoutEffect } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DragHandle } from "../drag-handle";
import { blockLabel, type EditorBlock } from "./use-editor-blocks";

export const SortableBlock = memo(function SortableBlock({ block, showHandle, move }: {
  block: EditorBlock; showHandle: boolean; move: (key: string, direction: number) => void;
}) {
  const { setNodeRef, setActivatorNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({
    id: block.key, transition: null,
  });
  useLayoutEffect(() => { setNodeRef(block.element); return () => setNodeRef(null); }, [block.element, setNodeRef]);
  useLayoutEffect(() => {
    const { element } = block, previousTransform = element.style.transform, previousTransition = element.style.transition;
    element.style.transform = CSS.Translate.toString(transform) || ""; element.style.transition = transition || "";
    if (isDragging) element.dataset.blockDragging = "true"; else delete element.dataset.blockDragging;
    return () => { element.style.transform = previousTransform; element.style.transition = previousTransition; delete element.dataset.blockDragging; };
  }, [block, isDragging, transform, transition]);
  return showHandle ? <DragHandle anchor={block.element} ref={setActivatorNodeRef} {...attributes} {...listeners}
    aria-label={`Move block: ${blockLabel(block)}`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
    onKeyDown={(event) => {
      if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); move(block.key, event.key === "ArrowUp" ? -1 : 1);
      } else listeners?.onKeyDown?.(event);
    }} /> : null;
});
