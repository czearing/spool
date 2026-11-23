"use client";

import type { Column, ColumnSizingState, Table } from "@tanstack/react-table";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { listSizing } from "./primitive-tokens";
import styles from "./list.module.css";

export function ListResize<T>({ column, table, label, onResizingChange }:
  { column: Column<T>; table: Table<T>; label: string; onResizingChange: (active: boolean) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ x: number; widths: ColumnSizingState; previous: ColumnSizingState; direction: number } | null>(null);
  const [width, setWidth] = useState(column.getSize());
  const [active, setActive] = useState(false);
  const min = column.columnDef.minSize ?? listSizing.min;
  const max = column.columnDef.maxSize ?? listSizing.max;
  const clamp = (value: number) => Math.min(max, Math.max(min, value));
  useLayoutEffect(() => {
    const cell = ref.current?.closest("th");
    if (!cell) return;
    const observer = new ResizeObserver(() => setWidth(Math.round(cell.getBoundingClientRect().width)));
    observer.observe(cell);
    return () => observer.disconnect();
  }, []);
  function measure() {
    const cells = ref.current!.closest("table")!.querySelectorAll<HTMLTableCellElement>("thead th[data-column]");
    return Object.fromEntries([...cells].map((cell) => [cell.dataset.column!, cell.getBoundingClientRect().width]));
  }
  function cancel() {
    if (drag.current) table.setColumnSizing(drag.current.previous);
    drag.current = null;
    setActive(false);
    onResizingChange(false);
  }
  function start(event: PointerEvent<HTMLSpanElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    const widths = measure();
    drag.current = { x: event.clientX, widths, previous: table.getState().columnSizing,
      direction: getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1 };
    event.currentTarget.setPointerCapture(event.pointerId);
    table.setColumnSizing(widths);
    setActive(true);
    onResizingChange(true);
  }
  function keyboard(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === "Escape") { cancel(); return; }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const widths = measure();
    const direction = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
    const step = event.shiftKey ? listSizing.largeStep : listSizing.step;
    const next = event.key === "Home" ? min : event.key === "End" ? max
      : widths[column.id] + (event.key === "ArrowRight" ? step : -step) * direction;
    table.setColumnSizing({ ...widths, [column.id]: clamp(next) });
  }
  return <span ref={ref} className={styles.resize} role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label={`Resize ${label}`} aria-valuenow={clamp(width)} aria-valuemin={min} aria-valuemax={max}
    aria-valuetext={`${width} pixels`} data-resizing={active}
    title="Drag or use arrow keys to resize. Shift changes faster. Home/End set limits. Escape cancels."
    onClick={(event) => event.stopPropagation()}
    onKeyDown={keyboard} onPointerDown={start}
    onPointerMove={(event) => {
      const current = drag.current;
      if (current) table.setColumnSizing({ ...current.widths,
        [column.id]: clamp(current.widths[column.id] + (event.clientX - current.x) * current.direction) });
    }}
    onPointerUp={(event) => {
      drag.current = null;
      setActive(false);
      onResizingChange(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onDoubleClick={() => table.resetColumnSizing()} />;
}
