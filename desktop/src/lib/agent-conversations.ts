import type { AgentJob, AgentJobs } from "./agent-jobs";

export function agentConversations(jobs: AgentJobs): AgentJob[] {
  return [...jobs.current, ...jobs.history]
    .filter((job) => !job.archived || job.key.startsWith("task:"))
    .sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0) || a.id.localeCompare(b.id));
}

export function conversationTitle(markdown: string) {
  const first = markdown.trim().split(/\r?\n/, 1)[0];
  const text = Array.from((first.replace(/^#{1,6}\s+/, "") || first).replace(/\s+/g, " "));
  return text.length > 80 ? `${text.slice(0, 77).join("")}...` : text.join("");
}
