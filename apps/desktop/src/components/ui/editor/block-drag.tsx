import { useCallback, useMemo, useRef, useState } from "react";
import { DndContext, DragOverlay, PointerSensor, KeyboardSensor, closestCenter, pointerWithin, useSensor, useSensors, type CollisionDetection } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { $getNodeByKey, $getRoot, HISTORY_PUSH_TAG } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { DropIndicator } from "../drop-indicator";
import { ElementPreview } from "../element-preview";
import { Text } from "../text";
import { blockLabel, useEditorBlocks } from "./use-editor-blocks";
import { SortableBlock } from "./sortable-block";
import styles from "./editor.module.css";

export function BlockDrag({ anchor }: { anchor: HTMLElement }) {
  const [editor] = useLexicalComposerContext(), activeRef = useRef<string | null>(null);
  const { blocks, hovered, setHovered } = useEditorBlocks(editor, anchor, activeRef);
  const ids = useMemo(() => blocks.map((block) => block.key), [blocks]);
  const [active, setActive] = useState<string | null>(null), [over, setOver] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const collision: CollisionDetection = useCallback((args) => {
    const point = args.pointerCoordinates;
    if (!point) return closestCenter(args);
    if (!anchor.contains(anchor.ownerDocument.elementFromPoint(point.x, point.y))) return [];
    const hits = pointerWithin(args);
    return hits.length ? hits : closestCenter({ ...args,
      collisionRect: { left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0, height: 0 } });
  }, [anchor]);
  const commit = useCallback((key: string, index: number) => {
    const from = ids.indexOf(key);
    if (from < 0 || index < 0 || index >= ids.length || index === from) return;
    const order = arrayMove(ids, from, index), nextKey = order[index + 1];
    editor.update(() => {
      const node = $getNodeByKey(key), next = nextKey ? $getNodeByKey(nextKey) : null;
      if (!node || (nextKey && !next)) throw new Error("The document changed during the move. Try dragging the block again.");
      if (next) next.insertBefore(node); else $getRoot().append(node);
    }, { tag: HISTORY_PUSH_TAG, onUpdate: () => {
      setHovered(key); setAnnouncement(`Moved block to position ${index + 1} of ${ids.length}.`);
    } });
  }, [editor, ids, setHovered]);
  const move = useCallback((key: string, direction: number) => commit(key, ids.indexOf(key) + direction), [commit, ids]);
  const reset = () => { activeRef.current = null; setActive(null); setOver(null); };
  const selected = blocks.find((block) => block.key === active), destination = blocks.find((block) => block.key === over);
  return <DndContext sensors={sensors} collisionDetection={collision}
    onDragStart={({ active: item }) => { activeRef.current = String(item.id); setActive(String(item.id)); }}
    onDragOver={({ over: item }) => setOver(item ? String(item.id) : null)}
    onDragCancel={() => { reset(); setAnnouncement("Block move cancelled."); }}
    onDragEnd={({ active: item, over: target }) => { if (target) commit(String(item.id), ids.indexOf(String(target.id))); reset(); }}
    accessibility={{ screenReaderInstructions: { draggable: "Space picks up a block. Up and Down select a position. Space drops; Escape cancels. Alt+Up or Down moves one position." },
      announcements: {
        onDragStart: ({ active: item }) => `Picked up ${blockLabel(blocks.find((block) => block.key === item.id))}.`,
        onDragOver: ({ over: item }) => item ? `Position ${ids.indexOf(String(item.id)) + 1} of ${ids.length}.` : "Outside the document.",
        onDragEnd: ({ over: item }) => item ? "Block move finished." : "Block unchanged.",
        onDragCancel: () => "Block move cancelled.",
      } }}>
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      {blocks.map((block) => <SortableBlock key={block.key} block={block} showHandle={block.key === (active || hovered)} move={move} />)}
    </SortableContext>
    {selected && destination && selected.key !== destination.key && <DropIndicator anchor={destination.element}
      placement={ids.indexOf(selected.key) < ids.indexOf(destination.key) ? "after" : "before"} />}
    <DragOverlay dropAnimation={null} style={{ pointerEvents: "none" }}>{selected && <ElementPreview element={selected.element} />}</DragOverlay>
    <Text className={styles.srOnly} role="status">{announcement}</Text>
  </DndContext>;
}
