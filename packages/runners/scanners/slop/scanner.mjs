import { writeRunnerJson } from "../../packages/bohemia-agent-tooling/src/index.js";
import { buildTodoData } from "./todo.js";
import { loadTargets } from "./metrics.js";
import { dispatchNextSlopTask } from "./handoff.js";

export async function runScanner({ config, queue, prepare, holding, scan }) {
  const targets = loadTargets(config.targetsPath);
  const active = (await queue.listIssues({ assigneeAgentId: config.agentId })).filter(task =>
    ["todo", "in_progress", "in_review", "blocked"].includes(task.status));
  const collect = activeTasks => buildTodoData({
    repoRoot: scan.repoRoot, trees: config.trees, minScore: config.minSlopScore,
    maxRankedFiles: config.maxRankedFiles, maxOpenTasks: config.maxOpenTasks,
    activeTasks, budgets: targets.budgets,
  });
  const data = collect(active);
  writeRunnerJson(config.todoJsonPath, { ...data, scan, dispatchHolding: holding });
  const candidate = data.rankedTasks.find(task => !task.isInFlight);
  if (holding || !candidate || active.length >= config.maxOpenTasks) {
    return { dispatched: 0, observed: data.summary.totalFilesScanned };
  }
  const result = await dispatchNextSlopTask({
    candidate, agentId: config.agentId, repoRoot: config.agentWorkspaceRoot,
    maxOpenTasks: config.maxOpenTasks, queue, prepare,
  });
  if (result.dispatched) {
    const updated = (await queue.listIssues({ assigneeAgentId: config.agentId })).filter(task =>
      ["todo", "in_progress", "in_review", "blocked"].includes(task.status));
    writeRunnerJson(config.todoJsonPath, { ...collect(updated), scan, dispatchHolding: holding });
  }
  return { dispatched: Number(result.dispatched), taskId: result.issueId,
    reason: result.reason, observed: data.summary.totalFilesScanned };
}
