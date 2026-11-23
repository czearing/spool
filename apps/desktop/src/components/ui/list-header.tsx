import type { Table } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useColumnReorder } from "../../hooks/use-column-reorder";
import type { ListColumn } from "./list";
import { DropIndicator } from "./drop-indicator";
import { Stack } from "./stack";
import styles from "./list.module.css";

export function ListHeader<T>({ column, table, label, disabled, resetLayout, announce }:
  { column: ListColumn<T>; table: Table<T>; label: string; disabled: boolean; resetLayout: () => void; announce: (text: string) => void }) {
  const model = table.getColumn(column.key)!;
  const direction = model.getIsSorted();
  const Icon = direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : ArrowUpDown;
  const drag = useColumnReorder(table, column.key, label, announce, resetLayout);
  return <>
    <Stack asChild direction="row" align="center" justify={column.align ?? "start"} gap={2}><button ref={drag.ref} type="button" className={styles.sort} aria-label={label} disabled={disabled}
      data-dragging={drag.active} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+Home"
      title={`${model.getCanSort() ? "Click to sort. " : ""}Drag to move. Alt+Left/Right moves columns; Alt+Home resets the layout.`}
      onClick={model.getCanSort() ? model.getToggleSortingHandler() : undefined} {...drag.handlers}>
      {column.icon && <span className={styles.icon} aria-hidden="true">{column.icon}</span>}
      <span>{column.header}</span>
      {model.getCanSort() && <Icon className={styles.sortIcon} aria-hidden="true" />}
    </button></Stack>
    {drag.target && <DropIndicator orientation="vertical" rect={{
      x: drag.target.x, y: drag.target.y, height: drag.target.height, width: 0,
    }} />}
  </>;
}
