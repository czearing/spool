import { useEffect, useRef, useState } from "react";
import { KeyboardSensor, MouseSensor, TouchSensor, pointerWithin, closestCenter, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import { isStatus, labels, statuses, type Command, type Status, type WorkItem } from "../lib/work-items";

export function useBoardDrag(items: WorkItem[], dispatch: (command: Command) => void,
  visibleItems: WorkItem[], sorted: boolean, notify: (message: string) => void) {
  const [active, setActive] = useState<WorkItem | null>(null);
  const focusTarget = useRef<string | null>(null);
  const keyboardTarget = useRef<string | null>(null);
  const insertion = useRef<{ status: Status; index: number } | null>(null);
  const statusOf = (over: DragEndEvent["over"]) => {
    const value: unknown = over?.data.current?.status ?? over?.id;
    return isStatus(value) ? value : undefined;
  };
  const keyboardCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
    const { active: source, over, collisionRect, droppableRects } = context;
    const item = items.find((candidate) => candidate.id === source?.id);
    if (!item || !collisionRect) return;
    const current = statusOf(over) ?? item.status;
    const index = statuses.indexOf(current);
    const rtl = context.activeNode && getComputedStyle(context.activeNode).direction === "rtl";
    let target: string | undefined;
    if (event.code === "ArrowRight") target = statuses[index + (rtl ? -1 : 1)];
    if (event.code === "ArrowLeft") target = statuses[index + (rtl ? 1 : -1)];
    if (event.code === "ArrowDown") target = "archive";
    if (event.code === "ArrowUp") target = item.status;
    if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.code)) {
      if (sorted) { notify("Choose Manual order in Sort to rearrange tasks."); return; }
      const column = visibleItems.filter((candidate) => candidate.status === current);
      const remaining = column.filter((candidate) => candidate.id !== item.id);
      const at = insertion.current?.status === current ? insertion.current.index : column.findIndex((candidate) => candidate.id === item.id);
      const next = Math.max(0, Math.min(remaining.length, (at < 0 ? remaining.length : at) + (event.code === "ArrowUp" ? -1 : 1)));
      insertion.current = { status: current, index: next };
      target = remaining[next] ? `item:${remaining[next].id}` : current;
    }
    if (!target) return;
    const rect = droppableRects.get(target);
    if (!rect) return;
    keyboardTarget.current = target;
    if (!event.altKey) insertion.current = null;
    return { x: currentCoordinates.x + rect.left + rect.width / 2 - collisionRect.left - collisionRect.width / 2,
      y: currentCoordinates.y + rect.top + rect.height / 2 - collisionRect.top - collisionRect.height / 2 };
  };
  const collisionDetection: CollisionDetection = (args) => {
    if (!args.pointerCoordinates && keyboardTarget.current) return [{ id: keyboardTarget.current }];
    const hits = (args.pointerCoordinates ? pointerWithin : closestCenter)(args);
    return args.pointerCoordinates ? [...hits].sort((a, b) => Number(String(b.id).startsWith("item:")) - Number(String(a.id).startsWith("item:"))) : hits;
  };
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates, scrollBehavior: "auto" }));
  useEffect(() => {
    if (focusTarget.current) {
      (document.getElementById(focusTarget.current) ?? document.getElementById("board-items"))?.focus();
      focusTarget.current = null;
    }
  }, [items]);
  function onDragEnd({ active: source, over, activatorEvent }: DragEndEvent) {
    setActive(null); keyboardTarget.current = null;
    if (!over) return;
    const item = items.find((candidate) => candidate.id === source.id);
    const status = statusOf(over);
    if (!item || (item.archived && over.id === "archive") || (!status && over.id !== "archive")) return;
    if (sorted && status === item.status && !item.archived) { notify("Choose Manual order in Sort to rearrange tasks."); return; }
    if (activatorEvent instanceof KeyboardEvent) focusTarget.current = over.id === "archive" ? "archive" : `work-item-${source.id}`;
    if (over.id === "archive") dispatch({ type: "archive", id: item.id });
    else if (status) dispatch({ type: "move", id: item.id, status,
      beforeId: sorted ? undefined : over.data.current?.itemId, atEnd: sorted || !over.data.current?.itemId });
  }
  const destination = (over: DragEndEvent["over"]) => {
    if (over?.id === "archive") return "Archive";
    const status = statusOf(over), before = items.find((item) => item.id === over?.data.current?.itemId);
    return status ? `${labels[status]}${before ? `, before ${before.title}` : ""}` : "a column";
  };
  return { active, context: {
    sensors, collisionDetection, onDragEnd,
    onDragStart: ({ active: source }: DragStartEvent) => {
      keyboardTarget.current = null; insertion.current = null;
      setActive(items.find((item) => item.id === source.id) ?? null);
    },
    onDragCancel: () => { setActive(null); keyboardTarget.current = null; },
    accessibility: {
      screenReaderInstructions: { draggable: "Space or Enter picks up an item. Left and Right select columns. Down selects Archive; Up selects the original column. Alt+Up or Down reorders an item. Space drops; Escape cancels." },
      announcements: {
        onDragStart: () => "Picked up.",
        onDragOver: ({ over }: Pick<DragEndEvent, "over">) => over ? `Over ${destination(over)}.` : "Outside a drop target.",
        onDragEnd: ({ over }: Pick<DragEndEvent, "over">) => over ? `Drop requested in ${destination(over)}.` : "Unchanged.",
        onDragCancel: () => "Drag cancelled. Unchanged.",
      },
    },
  } };
}
