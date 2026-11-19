import { engine } from "./sources.mjs";
import path from "node:path";
import { readJson } from "./spool-store.mjs";
import { publicationsForProject } from "./publications.mjs";

function ownedBranches(store, agent) {
  return [...store.tasks().filter(task => task.agent === agent).map(task => store.metadata(task.id)?.preparation?.branch),
    ...publicationsForProject(store).filter(record => record?.verified === true && record.agent === agent)
      .map(record => record.branch)].filter(Boolean);
}

export function agentPullRequests(store, agent, prs, legacyBranchPrefixes = []) {
  const branchName = value => value?.replace(/^refs\/heads\//, "");
  const branches = new Set(ownedBranches(store, agent).map(branchName));
  return prs.filter(pr => (!pr.status || pr.status === "active") && (branches.has(branchName(pr.branch)) ||
    legacyBranchPrefixes.some(prefix => branchName(pr.branch)?.replace(/^users?\/[^/]+\//, "").startsWith(prefix))));
}

export async function workload(store, agent, cap, workspace, adoConfig, legacyBranchPrefixes = [], listPullRequests,
  { allowOpenPrOverflow = false } = {}) {
  if (typeof allowOpenPrOverflow !== "boolean") throw new Error("Open PR capacity exception must be explicit");
  if (store.isPaused(agent)) return `Spool agent ${agent} is paused by operator`;
  const tasks = store.tasks();
  const owns = t => t.agent === agent || store.ownsWorkspace(t, agent, workspace);
  if (tasks.some(t => owns(t) && ["incoming", "in_progress"].includes(t.status)) ||
      store.liveTasks(tasks).some(owns)) return "Existing Spool task or session owns the agent/workspace";
  const branches = new Set(ownedBranches(store, agent));
  if (!branches.size && !legacyBranchPrefixes.length) return null;
  const { listOwnPullRequests } = await engine("pr-updater/lib/azure-devops.mjs");
  const prs = await (listPullRequests || listOwnPullRequests)(adoConfig, { allPages: true, refresh: true });
  const open = agentPullRequests(store, agent, prs, legacyBranchPrefixes).length;
  return open >= cap && !allowOpenPrOverflow ? `Open PR limit reached (${open}/${cap})` : null;
}
