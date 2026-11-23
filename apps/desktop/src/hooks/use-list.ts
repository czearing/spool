"use client";

import { getCoreRowModel, getSortedRowModel, sortingFns, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { useMemo, useState, type Key } from "react";
import type { ListColumn } from "../components/ui/list";
import { listSizing } from "../components/ui/primitive-tokens";
import { useListPreferences } from "./use-list-preferences";

export type ListSort = { key: string; direction: "asc" | "desc" } | null;
export type ListSorting = {
  sort?: ListSort;
  defaultSort?: ListSort;
  onSortChange?: (sort: ListSort) => void;
  manualSorting?: boolean;
};

export function useList<T>({ items, columns, getRowKey, sort, defaultSort = null, onSortChange, manualSorting = false, preferencesKey }:
  ListSorting & { items: readonly T[]; columns: readonly ListColumn<T>[]; getRowKey: (item: T) => Key; preferencesKey?: string }) {
  const preferences = useListPreferences(preferencesKey);
  const [internalSort, setInternalSort] = useState(defaultSort);
  const current = sort === undefined ? internalSort : sort;
  const sorting = useMemo<SortingState>(() => current ? [{ id: current.key, desc: current.direction === "desc" }] : [], [current]);
  const data = useMemo(() => [...items], [items]);
  const definitions = useMemo<ColumnDef<T>[]>(() => columns.map((column) => ({
    id: column.key,
    accessorFn: column.sortValue,
    enableSorting: Boolean(column.sortValue),
    enableResizing: column.resizable !== false,
    minSize: column.minWidth ?? listSizing.min,
    maxSize: column.maxWidth ?? listSizing.max,
    sortDescFirst: false,
    sortUndefined: "last",
    sortingFn: (a, b, id) => {
      if (column.compare) return column.compare(a.original, b.original);
      const value = a.getValue(id) ?? b.getValue(id);
      const compare = typeof value === "string" ? sortingFns.alphanumeric : value instanceof Date ? sortingFns.datetime : sortingFns.basic;
      return compare(a, b, id);
    },
  })), [columns]);
  const table = useReactTable({
    data, columns: definitions, getRowId: (item) => String(getRowKey(item)),
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
    state: { sorting, columnSizing: preferences.layout.widths, columnOrder: preferences.layout.order },
    onColumnSizingChange: preferences.setWidths, onColumnOrderChange: preferences.setOrder,
    manualSorting, enableMultiSort: false, autoResetPageIndex: false,
    onSortingChange: (updater) => {
      const [next] = typeof updater === "function" ? updater(sorting) : updater;
      const value: ListSort = next ? { key: next.id, direction: next.desc ? "desc" : "asc" } : null;
      if (sort === undefined) setInternalSort(value);
      onSortChange?.(value);
    },
  });
  return { table, preferencesError: preferences.error, resetLayout: preferences.reset, setResizing: preferences.setResizing };
}
