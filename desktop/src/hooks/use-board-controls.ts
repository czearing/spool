import { useMemo, useState } from "react";
import { selectBoardItems, type BoardSort } from "../lib/board-items";
import { labels, type Status, type WorkItem } from "../lib/work-items";

export function useBoardControls(items: WorkItem[], statusLabels = labels) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Status[]>([]);
  const [sort, setSort] = useState<BoardSort>("manual");
  const visible = useMemo(() => selectBoardItems(items, query, selected, sort, statusLabels), [items, query, selected, sort, statusLabels]);
  return {
    query, setQuery, selected, sort, setSort, visible, hasFilters: !!query.trim() || selected.length > 0,
    toggleStatus: (status: Status) => setSelected((current) =>
      current.includes(status) ? current.filter((value) => value !== status) : [...current, status]),
    clearFilters: () => { setQuery(""); setSelected([]); },
  };
}
