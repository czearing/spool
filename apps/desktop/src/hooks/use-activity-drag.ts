import { useEffect, useRef, useState } from "react";
import { KeyboardCode, KeyboardSensor, MouseSensor, TouchSensor, pointerWithin, rectIntersection, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import type { ActivityEntry } from "../components/activity-overview";

const keyboardCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  const target = event.code === "ArrowUp" ? "conversations" : event.code === "ArrowDown" ? "archive" : null;
  const rect = target && context.droppableRects.get(target), source = context.collisionRect;
  if (!rect || !source) return;
  event.preventDefault();
  return { x: currentCoordinates.x + rect.left + rect.width / 2 - source.left - source.width / 2,
    y: currentCoordinates.y + rect.top + rect.height / 2 - source.top - source.height / 2 };
};
const mouseOptions = { activationConstraint: { distance: 5 } };
const touchOptions = { activationConstraint: { delay: 180, tolerance: 8 } };
const keyboardOptions = { coordinateGetter: keyboardCoordinates, scrollBehavior: "auto" as const,
  keyboardCodes: { start: [KeyboardCode.Space], cancel: [KeyboardCode.Esc], end: [KeyboardCode.Space] } };
const collisionDetection: CollisionDetection = args => (args.pointerCoordinates ? pointerWithin : rectIntersection)(args);

export function useActivityDrag(entries: ActivityEntry[], onArchive?: (id: string, archived: boolean) => void) {
  const [active, setActive] = useState<ActivityEntry | null>(null);
  const clickCleanup = useRef<(() => void) | null>(null);
  const focusTarget = useRef<{ sidebar: HTMLElement | null; id: string; archived: boolean } | null>(null);
  useEffect(() => () => clickCleanup.current?.(), []);
  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    const group = target.sidebar?.querySelector<HTMLElement>(`[data-archive="${target.archived}"]`);
    if (!group) return;
    (group.querySelector<HTMLElement>(`a[data-work-item-id="${CSS.escape(target.id)}"]`)
      ?? group.querySelector<HTMLButtonElement>("button") ?? group).focus();
    focusTarget.current = null;
  }, [entries]);
  function suppressDragClick(event: Event) {
    if (event instanceof KeyboardEvent) return;
    clickCleanup.current?.();
    // dnd-kit stops React's click handler, but links still need their native navigation prevented.
    const prevent = (click: Event) => click.preventDefault();
    const release = () => { setTimeout(cleanup, 50); };
    const cleanup = () => {
      document.removeEventListener("click", prevent, true);
      document.removeEventListener("mouseup", release, true);
      document.removeEventListener("touchend", release, true);
      if (clickCleanup.current === cleanup) clickCleanup.current = null;
    };
    document.addEventListener("click", prevent, true);
    document.addEventListener("mouseup", release, true);
    document.addEventListener("touchend", release, true);
    clickCleanup.current = cleanup;
  }
  const sensors = useSensors(useSensor(MouseSensor, mouseOptions), useSensor(TouchSensor, touchOptions),
    useSensor(KeyboardSensor, keyboardOptions));
  return { active, context: {
    sensors, collisionDetection,
    onDragStart: ({ active: source, activatorEvent }: DragStartEvent) => {
      suppressDragClick(activatorEvent);
      setActive(entries.find(entry => entry.id === source.id) ?? null);
    },
    onDragCancel: () => setActive(null),
    onDragEnd: ({ active: source, over, activatorEvent }: DragEndEvent) => {
      setActive(null);
      const entry = entries.find(entry => entry.id === source.id);
      if (!entry || !over || !["archive", "conversations"].includes(String(over.id))) return;
      const archived = over.id === "archive";
      if (Boolean(entry.archived) !== archived) {
        if (activatorEvent instanceof KeyboardEvent && activatorEvent.target instanceof Element) {
          focusTarget.current = { sidebar: activatorEvent.target.closest("aside"), id: entry.id, archived };
        }
        onArchive?.(entry.id, archived);
      }
    },
    accessibility: {
      restoreFocus: false,
      screenReaderInstructions: { draggable: "Space picks up a conversation. Up selects Conversations; Down selects Archive. Space drops; Escape cancels." },
      announcements: {
        onDragStart: () => "Picked up conversation.",
        onDragOver: ({ over }: Pick<DragEndEvent, "over">) => over ? `Over ${over.id === "archive" ? "Archive" : "Conversations"}.` : "Outside a drop target.",
        onDragEnd: ({ over }: Pick<DragEndEvent, "over">) => over ? "Conversation dropped." : "Unchanged.",
        onDragCancel: () => "Drag cancelled.",
      },
    },
  } };
}
