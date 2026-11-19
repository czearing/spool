import type { AgentJob, AgentJobs } from "./agent-jobs";
import { spoolStatuses } from "./spool-model";

export const agentWorkLabels = { pending: "Pending", starting: "Starting", running: "Running" } as const;
export function isAgentJobs(value: unknown): value is AgentJobs {
  const isJob = (job: unknown) => !!job && typeof job === "object" &&
    "id" in job && typeof job.id === "string" && "title" in job && typeof job.title === "string" &&
    "key" in job && typeof job.key === "string" && "archived" in job && typeof job.archived === "boolean" &&
    "updatedAt" in job && (job.updatedAt === null || typeof job.updatedAt === "string") &&
    "status" in job && spoolStatuses.some(status => status.id === job.status) &&
    (!("activity" in job) || job.activity === undefined || typeof job.activity === "string" && Object.hasOwn(agentWorkLabels, job.activity));
  return !!value && typeof value === "object" && "current" in value && Array.isArray(value.current) && value.current.every(isJob) &&
    "history" in value && Array.isArray(value.history) && value.history.every(isJob);
}
export function agentConversations(jobs: AgentJobs): AgentJob[] {
  return [...jobs.current, ...jobs.history]
    .filter((job) => !job.archived || job.key.startsWith("task:"))
    .map(job => ({ job, time: Date.parse(job.updatedAt ?? "") || 0 }))
    .sort((a, b) => b.time - a.time || a.job.id.localeCompare(b.job.id))
    .map(({ job }) => job);
}

export function conversationTitle(markdown: string) {
  const first = markdown.trim().split(/\r?\n/, 1)[0];
  const text = Array.from((first.replace(/^#{1,6}\s+/, "") || first).replace(/\s+/g, " "));
  return text.length > 80 ? `${text.slice(0, 77).join("")}...` : text.join("");
}
export function updateConversationArchive(jobs: AgentJobs, id: string, archived: boolean): AgentJobs {
  const update = (job: AgentJob) => job.id === id && (!job.archived || job.key.startsWith("task:"))
    ? { ...job, archived, key: archived ? `task:${id}` : `${job.status}:${id}.json` } : job;
  const all = [...jobs.current, ...jobs.history].map(update);
  const current = (job: AgentJob) => !job.archived && ["incoming", "in_progress"].includes(job.status);
  return { current: all.filter(current), history: all.filter(job => !current(job)) };
}
