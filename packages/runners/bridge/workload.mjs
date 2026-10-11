import { engine } from "./sources.mjs";
import { samePath } from "./spool-store.mjs";

export function agentPullRequests(store, agent, prs, legacyBranchPrefixes = []) {
  const branchName = value => value?.replace(/^refs\/heads\//, "");
  const branches = new Set(store.tasks().filter(t => t.agent === agent)
    .map(t => branchName(store.metadata(t.id)?.preparation?.branch)).filter(Boolean));
  return prs.filter(pr => (!pr.status || pr.status === "active") && (branches.has(branchName(pr.branch)) ||
    legacyBranchPrefixes.some(prefix => branchName(pr.branch)?.replace(/^users?\/[^/]+\//, "").startsWith(prefix))));
}

export async function workload(store, agent, cap, workspace, adoConfig, legacyBranchPrefixes = [], listPullRequests,
  { allowOpenPrOverflow = false } = {}) {
  if (typeof allowOpenPrOverflow !== "boolean") throw new Error("Open PR capacity exception must be explicit");
  if (store.isPaused(agent)) return `Spool agent ${agent} is paused by operator`;
  const tasks = store.tasks();
  const owns = t => t.agent === agent || samePath(t.workspace, workspace);
  if (tasks.some(t => owns(t) && ["incoming", "in_progress"].includes(t.status)) ||
      store.liveTasks(tasks).some(owns)) return "Existing Spool task or session owns the agent/workspace";
  const branches = new Set(tasks.filter(t => t.agent === agent)
    .map(t => store.metadata(t.id)?.preparation?.branch).filter(Boolean));
  if (!branches.size && !legacyBranchPrefixes.length) return null;
  const { listOwnPullRequests } = await engine("pr-updater/lib/azure-devops.mjs");
  const prs = await (listPullRequests || listOwnPullRequests)(adoConfig, { allPages: true, refresh: true });
  const open = agentPullRequests(store, agent, prs, legacyBranchPrefixes).length;
  return open >= cap && !allowOpenPrOverflow ? `Open PR limit reached (${open}/${cap})` : null;
}
