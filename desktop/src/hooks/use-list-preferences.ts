"use client";

import { useEffect, useState } from "react";
import type { ColumnSizingState, Updater } from "@tanstack/react-table";

export type ListLayout = { widths: ColumnSizingState; order: string[] };
export const emptyLayout: ListLayout = { widths: {}, order: [] };

export function parseListLayout(raw: string): ListLayout {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
    || !("widths" in value) || !value.widths || typeof value.widths !== "object" || Array.isArray(value.widths)
    || !Object.values(value.widths).every((width) => typeof width === "number" && Number.isFinite(width) && width > 0)
    || !("order" in value) || !Array.isArray(value.order) || !value.order.every((key) => typeof key === "string")
    || new Set(value.order).size !== value.order.length) throw new Error("Invalid saved list layout.");
  return { widths: Object.fromEntries(Object.entries(value.widths)), order: value.order };
}

export function useListPreferences(preferencesKey?: string) {
  const [state, setState] = useState({ key: preferencesKey, layout: emptyLayout, dirty: false });
  const [error, setError] = useState<string>();
  const [resizing, setResizing] = useState(false);
  const layout = state.key === preferencesKey ? state.layout : emptyLayout;
  const key = preferencesKey ? `spool:list:${preferencesKey}` : undefined;
  useEffect(() => {
    setError(undefined);
    let saved = emptyLayout;
    try {
      const raw = key ? localStorage.getItem(key) : null;
      if (raw) saved = parseListLayout(raw);
    } catch (cause) {
      setError(`Could not restore list layout: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    setState({ key: preferencesKey, layout: saved, dirty: false });
  }, [key, preferencesKey]);
  useEffect(() => {
    if (!key || state.key !== preferencesKey || !state.dirty) return;
    const save = () => {
      try {
        localStorage.setItem(key, JSON.stringify({ version: 1, ...state.layout }));
        setError(undefined);
      } catch (cause) {
        setError(`Could not save list layout: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    };
    if (!resizing) save();
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, [key, preferencesKey, state, resizing]);
  const update = <K extends keyof ListLayout>(field: K, updater: Updater<ListLayout[K]>) => {
    setState((previous) => {
      const current = previous.key === preferencesKey ? previous.layout : emptyLayout;
      const next = typeof updater === "function" ? updater(current[field]) : updater;
      return { key: preferencesKey, layout: { ...current, [field]: next }, dirty: true };
    });
  };
  return {
    layout, error, setResizing,
    setWidths: (updater: Updater<ColumnSizingState>) => update("widths", updater),
    setOrder: (updater: Updater<string[]>) => update("order", updater),
    reset: () => {
      setState({ key: preferencesKey, layout: emptyLayout, dirty: false });
      try { if (key) localStorage.removeItem(key); setError(undefined); }
      catch (cause) { setError(`Could not reset saved layout: ${cause instanceof Error ? cause.message : String(cause)}`); }
    },
  };
}
