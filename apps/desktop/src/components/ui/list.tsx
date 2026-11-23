"use client";

import { VisuallyHidden } from "radix-ui";
import { Fragment, useCallback, useId, useMemo, useRef, useState, type CSSProperties, type Key, type ReactElement, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useList, type ListSorting } from "../../hooks/use-list";
import { Text } from "./text";
import { ListResize } from "./list-resize";
import { ListHeader } from "./list-header";
import styles from "./list.module.css";

export type { ListSort } from "../../hooks/use-list";
export type ListColumn<T> = {
  key: string;
  header: ReactNode;
  sortLabel?: string;
  icon?: ReactNode;
  cell: (item: T) => ReactNode;
  sortValue?: (item: T) => string | number | Date | undefined;
  compare?: (a: T, b: T) => number;
  align?: "start" | "center" | "end";
  width?: CSSProperties["width"];
  minWidth?: number;
  maxWidth?: number;
  resizable?: boolean;
  rowHeader?: boolean;
};
type Props<T> = ListSorting & {
  label: string;
  items: readonly T[];
  columns: readonly ListColumn<T>[];
  getRowKey: (item: T) => Key;
  emptyMessage?: ReactNode;
  loading?: boolean;
  loadingMessage?: string;
  error?: string;
  density?: "comfortable" | "compact";
  appearance?: "bordered" | "plain";
  minWidth?: CSSProperties["minWidth"];
  maxHeight?: CSSProperties["maxHeight"];
  preferencesKey?: string;
  virtualize?: boolean;
  renderRow?: (item: T, row: ReactElement) => ReactNode;
};

export function List<T>({ label, items, columns, getRowKey, emptyMessage = "No items.",
  loading = false, loadingMessage = "Loading items...", error, density = "comfortable", appearance = "bordered", minWidth, maxHeight, preferencesKey, virtualize = false, renderRow, ...sorting }: Props<T>) {
  const { table, preferencesError, resetLayout, setResizing } = useList({ items, columns, getRowKey, preferencesKey, ...sorting });
  const [layoutMessage, setLayoutMessage] = useState("");
  const order = table.getState().columnOrder;
  const orderedColumns = useMemo(() => table.getAllLeafColumns().map((model) => columns.find((column) => column.key === model.id)!),
    [table, columns, order]);
  const sized = orderedColumns.some((column) => table.getState().columnSizing[column.key] !== undefined);
  const failed = error != null;
  const rows = failed ? [] : table.getRowModel().rows;
  const viewport = useRef<HTMLDivElement>(null), windowed = virtualize && !renderRow && rows.length > 200;
  const getItemKey = useCallback((index: number) => rows[index].id, [rows]);
  const virtual = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: rows.length, enabled: windowed, getScrollElement: () => viewport.current, getItemKey,
    estimateSize: () => 56, overscan: 6, initialRect: { width: 800, height: 320 },
  });
  const virtualRows = virtual.getVirtualItems();
  const visibleRows = useMemo(() => windowed ? virtualRows.map(({ index }) => rows[index]) : rows, [windowed, virtualRows, rows]);
  const first = windowed ? virtualRows[0] : undefined, last = windowed ? virtualRows.at(-1) : undefined;
  const top = first?.start ?? 0, bottom = last ? Math.max(0, virtual.getTotalSize() - last.end) : 0;
  const sortable = columns.some((column) => column.sortValue);
  const descriptionId = useId();
  const [activeSort] = table.getState().sorting;
  const activeColumn = columns.find((column) => column.key === activeSort?.id);
  const activeLabel = activeColumn?.sortLabel ?? (typeof activeColumn?.header === "string" ? activeColumn.header : activeColumn?.key);
  const sortMessage = activeSort
    ? `Sorted by ${activeLabel}, ${activeSort.desc ? "descending" : "ascending"}.`
    : "Original order.";
  const body = useMemo(() => <tbody>
    {top > 0 && <tr aria-hidden="true"><td colSpan={orderedColumns.length} style={{ height: top, padding: 0, border: 0 }} /></tr>}
    {visibleRows.map(({ original: item, id }, index) => {
      const row = <tr ref={windowed ? virtual.measureElement : undefined} data-index={windowed ? index + (first?.index ?? 0) : undefined}
        aria-rowindex={windowed ? index + (first?.index ?? 0) + 2 : undefined}>{orderedColumns.map((column) => {
        const Cell = column.rowHeader ? "th" : "td";
        return <Cell key={column.key} scope={column.rowHeader ? "row" : undefined}
          data-align={column.align ?? "start"}>{column.cell(item)}</Cell>;
      })}</tr>;
      return <Fragment key={id}>{renderRow ? renderRow(item, row) : row}</Fragment>;
    })}
    {bottom > 0 && <tr aria-hidden="true"><td colSpan={orderedColumns.length} style={{ height: bottom, padding: 0, border: 0 }} /></tr>}
    {!rows.length && <tr><td colSpan={orderedColumns.length} className={styles.empty}>
      <Text tone="secondary">{failed ? error : loading ? loadingMessage : emptyMessage}</Text>
    </td></tr>}
  </tbody>, [rows, visibleRows, windowed, virtual, first?.index, top, bottom, orderedColumns, renderRow, failed, error, loading, loadingMessage, emptyMessage]);
  return (
    <div ref={viewport} className={styles.scroll} style={{ width: sized ? table.getTotalSize() : undefined, maxHeight }}
      data-density={density} data-appearance={appearance} role="region" aria-label={`${label} list`} tabIndex={0}>
      <Text asChild><table className={styles.list} style={{ minWidth: sized ? undefined : minWidth, width: sized ? table.getTotalSize() : undefined }}
        aria-busy={loading} aria-describedby={descriptionId} aria-rowcount={windowed ? rows.length + 1 : undefined}>
        <caption><VisuallyHidden.Root>{label}</VisuallyHidden.Root></caption>
        <thead><tr aria-rowindex={windowed ? 1 : undefined}>{orderedColumns.map((column) => {
          const model = table.getColumn(column.key)!;
          const columnLabel = column.sortLabel ?? (typeof column.header === "string" ? column.header : column.key);
          const direction = model.getIsSorted();
          return (
            <Text asChild variant="meta" key={column.key}>
              <th scope="col" style={{ width: sized ? model.getSize() : column.width }} data-align={column.align ?? "start"}
                data-column={column.key} aria-label={columnLabel}
                aria-sort={direction ? direction === "asc" ? "ascending" : "descending" : undefined}>
                <ListHeader column={column} table={table} label={columnLabel} disabled={loading || failed}
                  resetLayout={resetLayout} announce={setLayoutMessage} />
                {model.getCanResize() && <ListResize column={model} table={table} label={columnLabel} onResizingChange={setResizing} />}
              </th>
            </Text>
          );
        })}</tr></thead>
        {body}
      </table></Text>
      {loading && rows.length > 0 && <Text asChild variant="meta" tone="secondary">
        <div className={styles.progress}>{loadingMessage}</div>
      </Text>}
      <VisuallyHidden.Root id={descriptionId}>
        {sortable && "Column header buttons sort ascending, descending, then restore the original order. "}
        Drag column edges or use arrow keys on their separators to resize. Drag headings to move columns.
        On a heading, Alt+Left/Right moves the column; Alt+Home resets the layout.
      </VisuallyHidden.Root>
      {preferencesError && <Text asChild tone="secondary"><div className={styles.progress} role="alert">{preferencesError}</div></Text>}
      <VisuallyHidden.Root role={failed ? "alert" : "status"} aria-atomic="true">
        {failed ? error : loading ? loadingMessage : sortable ? `${rows.length} items. ${sortMessage}` : ""}
        {layoutMessage && ` ${layoutMessage}`}
      </VisuallyHidden.Root>
    </div>
  );
}
