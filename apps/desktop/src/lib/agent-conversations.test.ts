import { expect, it } from "vitest";
import { agentConversations, conversationTitle, isAgentJobs } from "./agent-conversations";
import type { AgentJob } from "./agent-jobs";

const job: AgentJob = { id: "TASK-1", title: "A conversation", status: "in_progress", key: "in_progress:TASK-1.json",
  archived: false, updatedAt: "2026-10-05T20:00:00Z" };
it("accepts superseded reviews in live history without treating them as current work", () => {
  const jobs = { current: [], history: [{ ...job, status: "superseded" as const }] };
  expect(isAgentJobs(jobs)).toBe(true);
  expect(agentConversations(jobs)[0].status).toBe("superseded");
});
it("lists canonical conversations, including queued and board-archived tasks, without duplicating historical attempts", () => {
  const jobs = { current: [job, { ...job, id: "TASK-2", status: "incoming" as const, updatedAt: "2026-10-05T21:00:00Z" }],
    history: [{ ...job, id: "TASK-3", status: "completed" as const, key: "task:TASK-3", archived: true, updatedAt: null },
      { ...job, key: ".runner-archive:TASK-1-old", archived: true }] };
  expect(agentConversations(jobs).map(({ id }) => id)).toEqual(["TASK-2", "TASK-1", "TASK-3"]);
  expect(jobs.current[0]).toBe(job);
});
it("uses the first message line as a readable title without changing the prompt", () => {
  expect(conversationTitle("# Plan the next chapter\n\nKeep the outline intact.")).toBe("Plan the next chapter");
  expect(conversationTitle("  A   short message  ")).toBe("A short message");
  expect(conversationTitle("a".repeat(100))).toBe("a".repeat(77) + "...");
  expect(new TextEncoder().encode(conversationTitle("\u{1f600}".repeat(100))).length).toBeLessThan(500);
});
it("keeps chronological ordering, ID ties and original references for invalid and missing dates", () => {
  const current = [
    { ...job, id: "invalid-b", updatedAt: "bad" }, { ...job, id: "early", updatedAt: "1960-01-01T00:00:00Z" },
    { ...job, id: "missing", updatedAt: null }, { ...job, id: "epoch", updatedAt: "1970-01-01T00:00:00Z" },
    { ...job, id: "newest", updatedAt: "2026-11-04T00:00:00Z" }, { ...job, id: "invalid-a", updatedAt: "bad" },
  ];
  const original = [...current], sorted = agentConversations({ current, history: [] });
  expect(sorted.map(item => item.id)).toEqual(["newest", "epoch", "invalid-a", "invalid-b", "missing", "early"]);
  expect(current).toEqual(original);
  for (const item of sorted) expect(item).toBe(original.find(candidate => candidate.id === item.id));
});
