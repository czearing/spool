export const statuses = ["backlog", "in-progress", "completed", "blocked"] as const;
export type Status = (typeof statuses)[number];
export type WorkItem = { id: string; title: string; status: Status; archived?: boolean; agent?: string; updatedAt?: string | null };
export type Command =
  | { type: "move"; id: string; status: Status; beforeId?: string; atEnd?: boolean }
  | { type: "create"; item: WorkItem }
  | { type: "archive-all"; status: "completed" | "blocked" }
  | { type: "archive"; id: string };

export const labels: Record<Status, string> = {
  backlog: "Backlog", "in-progress": "In progress", completed: "Completed", blocked: "Blocked",
};

export function isStatus(value: unknown): value is Status {
  return statuses.some((status) => status === value);
}

export function applyCommand(items: WorkItem[], command: Command): WorkItem[] {
  if (command.type === "archive-all") return items.map((item) =>
    item.status === command.status && !item.archived ? { ...item, archived: true } : item);
  if (command.type === "create") {
    if (!command.item.title.trim()) throw new Error("Enter a task title.");
    if (!isStatus(command.item.status)) throw new Error("Choose a valid status.");
    if (items.some((item) => item.id === command.item.id)) throw new Error("This task already exists.");
    return [...items, { ...command.item, title: command.item.title.trim() }];
  }
  const current = items.find((item) => item.id === command.id);
  if (!current) throw new Error("This work item does not exist.");
  if (command.type === "archive" && current.archived) throw new Error("This item is already archived.");
  const next = { ...current, ...(command.type === "move"
    ? { status: command.status, archived: false } : { archived: true }) };
  if (command.type === "move" && command.atEnd) return [...items.filter((item) => item.id !== current.id), next];
  if (command.type !== "move" || !command.beforeId || command.beforeId === current.id)
    return items.map((item) => item.id === current.id ? next : item);
  const remaining = items.filter((item) => item.id !== current.id);
  const index = remaining.findIndex((item) => item.id === command.beforeId);
  if (index < 0) throw new Error("The destination item no longer exists.");
  remaining.splice(index, 0, next);
  return remaining;
}
