export async function assertAgentWorkspaceIdle(queue, agentId) {
  if (!agentId || typeof queue.listIssues !== "function" || typeof queue.listLiveRuns !== "function") {
    throw new Error("Cannot verify agent workspace ownership and live runs");
  }
  const [issues, runs] = await Promise.all([queue.listIssues({ assigneeAgentId: agentId }), queue.listLiveRuns()]);
  if (!Array.isArray(issues) || !Array.isArray(runs)) throw new Error("Invalid workspace ownership response");
  if (issues.some(issue => issue.assigneeAgentId === agentId && ["todo", "in_progress", "in_review", "blocked"].includes(issue.status)) ||
      runs.some(run => run.agentId === agentId || run.agent?.id === agentId)) {
    throw new Error("Agent workspace is already owned by unfinished work or a live run; preparation held");
  }
}
