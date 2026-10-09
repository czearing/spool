import { labels, type Status, type WorkItem } from "./work-items";

export const boardSorts = [
  { value: "manual", label: "Manual order" },
  { value: "title-asc", label: "Title: A to Z" },
  { value: "title-desc", label: "Title: Z to A" },
  { value: "time-desc", label: "Updated: newest first" },
  { value: "time-asc", label: "Updated: oldest first" },
] as const;
export type BoardSort = (typeof boardSorts)[number]["value"];
export const isBoardSort = (value: string): value is BoardSort => boardSorts.some((sort) => sort.value === value);
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function selectBoardItems(items: WorkItem[], query: string, selected: Status[], sort: BoardSort, statusLabels = labels) {
  const search = query.trim().toLocaleLowerCase();
  const visible = items.filter((item) => !item.archived && (!selected.length || selected.includes(item.status))
    && `${item.id} ${item.title} ${item.agent ?? ""} ${statusLabels[item.status]}`.toLocaleLowerCase().includes(search));
  if (sort === "manual") return visible;
  return visible.sort((a, b) => {
    if (sort === "time-asc" || sort === "time-desc") {
      const left = Date.parse(a.updatedAt ?? ""), right = Date.parse(b.updatedAt ?? "");
      if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0;
      if (!Number.isFinite(right)) return -1;
      return (left - right) * (sort === "time-asc" ? 1 : -1);
    }
    return collator.compare(a.title, b.title) * (sort === "title-asc" ? 1 : -1);
  });
}
