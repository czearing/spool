import type { TaskPreparation } from "./task-preparation";

export const spoolQueues = [
  { id: "incoming", label: "Incoming", tone: "backlog" },
  { id: "in_progress", label: "In progress", tone: "in-progress" },
  { id: "completed", label: "Completed", tone: "completed" },
  { id: "failed", label: "Failed", tone: "blocked" },
] as const;
export const spoolStatuses = [...spoolQueues, { id: "superseded", label: "Superseded", tone: "superseded" },
  { id: "blocked", label: "Blocked", tone: "waiting" }] as const;
export type SpoolQueueStatus = typeof spoolQueues[number]["id"];
export type SpoolStatus = typeof spoolStatuses[number]["id"];
export type SpoolItem = { id: string; title: string; status: SpoolStatus; queueStatus?: SpoolQueueStatus; agent?: string; updatedAt?: string | null;
  preparation?: TaskPreparation };
export const taskRevision = (item: SpoolItem) => {
  const { queueStatus, ...revision } = item;
  return JSON.stringify({ ...revision, status: queueStatus ?? item.status });
};
export function normalizeTaskRevision(value: string) {
  try {
    const item = JSON.parse(value);
    if (item && typeof item.id === "string" && typeof item.title === "string" && typeof item.status === "string")
      return taskRevision(item);
  } catch {}
  return value;
}
