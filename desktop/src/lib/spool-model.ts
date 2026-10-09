export const spoolQueues = [
  { id: "incoming", label: "Incoming", tone: "backlog" },
  { id: "in_progress", label: "In progress", tone: "in-progress" },
  { id: "completed", label: "Completed", tone: "completed" },
  { id: "failed", label: "Failed", tone: "blocked" },
] as const;
export type SpoolStatus = typeof spoolQueues[number]["id"];
export type SpoolItem = { id: string; title: string; status: SpoolStatus; agent?: string; updatedAt?: string | null };
export const taskRevision = (item: SpoolItem) => JSON.stringify(item);
