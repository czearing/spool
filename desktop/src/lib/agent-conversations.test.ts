import { expect, it } from "vitest";
import { agentConversations, conversationTitle } from "./agent-conversations";
import type { AgentJob } from "./agent-jobs";

const job: AgentJob = { id: "TASK-1", title: "A conversation", status: "in_progress", key: "in_progress:TASK-1.json",
  archived: false, updatedAt: "2026-10-05T20:00:00Z" };
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
