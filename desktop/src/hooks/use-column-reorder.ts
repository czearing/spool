"use client";

import type { Table } from "@tanstack/react-table";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

type Target = { id: string; x: number; y: number; height: number };
type Gesture = { x: number; y: number; active: boolean; target: Target | null };

export function useColumnReorder<T>(table: Table<T>, id: string, label: string, announce: (text: string) => void, reset: () => void) {
  const ref = useRef<HTMLButtonElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const restoreFocus = useRef(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [active, setActive] = useState(false);
  const order = table.getState().columnOrder;
  useLayoutEffect(() => {
    if (restoreFocus.current) { ref.current?.focus(); restoreFocus.current = false; }
  }, [order]);
  function move(targetId: string) {
    const ids = table.getAllLeafColumns().map((column) => column.id);
    const from = ids.indexOf(id), to = ids.indexOf(targetId);
    if (from === to || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    restoreFocus.current = true;
    table.setColumnOrder(ids);
    announce(`Moved ${label} to column ${to + 1} of ${ids.length}.`);
  }
  function cancel() {
    if (gesture.current?.active) announce(`Column move cancelled.`);
    gesture.current = null;
    setActive(false);
    setTarget(null);
  }
  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current) return;
    const x = Math.abs(event.clientX - current.x), y = Math.abs(event.clientY - current.y);
    if (!current.active && y >= 6 && y > x) { suppressClick.current = true; cancel(); return; }
    if (!current.active && x < 6) return;
    event.preventDefault();
    current.active = true;
    suppressClick.current = true;
    setActive(true);
    const headers = [...event.currentTarget.closest("table")!.querySelectorAll<HTMLTableCellElement>("thead th[data-column]")];
    const destination = headers.find((cell) => {
      const rect = cell.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    if (!destination || destination.dataset.column === id) {
      current.target = null; setTarget(null); return;
    }
    const rect = destination.getBoundingClientRect();
    const after = headers.indexOf(destination) > headers.findIndex((cell) => cell.dataset.column === id);
    const rtl = getComputedStyle(destination).direction === "rtl";
    const next = { id: destination.dataset.column!, x: after !== rtl ? rect.right : rect.left, y: rect.top, height: rect.height };
    current.target = next;
    setTarget((previous) => previous?.id === next.id ? previous : next);
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") { cancel(); return; }
    if (!event.altKey || !["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Home") { reset(); announce("List layout reset."); return; }
    const ids = table.getAllLeafColumns().map((column) => column.id);
    const direction = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
    const next = ids[ids.indexOf(id) + (event.key === "ArrowRight" ? 1 : -1) * direction];
    if (next) move(next);
  }
  return {
    ref, active, target,
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0 || !event.isPrimary) return;
        suppressClick.current = false;
        gesture.current = { x: event.clientX, y: event.clientY, active: false, target: null };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: pointerMove,
      onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
        if (gesture.current?.active && gesture.current.target) move(gesture.current.target.id);
        gesture.current = null;
        setActive(false);
        setTarget(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      },
      onPointerCancel: cancel, onLostPointerCapture: cancel, onKeyDown: keyboard,
      onClickCapture: (event: MouseEvent<HTMLButtonElement>) => {
        if (event.detail && suppressClick.current) { event.preventDefault(); event.stopPropagation(); }
      },
    },
  };
}
