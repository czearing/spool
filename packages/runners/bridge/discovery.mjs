import { randomUUID } from "node:crypto";
import path from "node:path";
import { readJson, writeJson } from "./spool-store.mjs";
import { agentPullRequests, workload } from "./workload.mjs";
import { listOwnPullRequests } from "../scanners/pr-updater/lib/azure-devops.mjs";

const policies = {
  perf: { label: "Performance", cap: 3, branch: "new-office-perf",
    title: "Another safe New Office production improvement",
    prompt: distinct => `Find and implement one more small, safe New Office production-performance improvement distinct from ${distinct}, proving a real production cost reduction and preserved behavior before publishing.` },
  ci: { label: "CI", cap: 1, branch: "bohemia-ci",
    title: "A measured Bohemia CI-speed improvement",
    prompt: distinct => `Find and implement one small, safe Bohemia CI-speed improvement distinct from ${distinct}, proving reduced required-check completion time with at least three matched before and after CI runs and preserved coverage, reliability, and runner cost before publishing one PR.` },
};
export function discoveryPrompt(kind, prs = []) {
  if (!Object.hasOwn(policies, kind)) throw new Error("Unknown discovery policy");
  const ids = prs.map(pr => String(pr.id)).sort((a, b) => Number(a) - Number(b));
  if (ids.some(id => !/^\d+$/.test(id))) throw new Error(`${policies[kind].label} discovery requires numeric PR identities`);
  const distinct = ids.length ? `PR${ids.length === 1 ? "" : "s"} ${ids.join(", ")}` : "existing open PRs";
  return policies[kind].prompt(distinct);
}

export const performanceDiscoveryPrompt = prs => discoveryPrompt("perf", prs);
export const createPerformanceScan = options => createDiscoveryScan("perf", options);
export function createDiscoveryScan(kind, { store, config, queue, workspace, runtime, prepare,
  listPullRequests = listOwnPullRequests, observe = () => {} }) {
  if (!Object.hasOwn(policies, kind)) throw new Error("Unknown discovery policy");
  const policy = policies[kind];
  if (config.agentId !== kind || !Number.isSafeInteger(config.maxOpenPrs) ||
      config.maxOpenPrs < 1 || config.maxOpenPrs > policy.cap || !config.legacyBranchPrefixes?.length) {
    throw new Error(`${policy.label} discovery requires the ${kind} agent, PR ownership prefixes, and an open PR cap from 1 to ${policy.cap}`);
  }
  const file = path.join(runtime, `${kind}-discovery.json`);
  async function capacity() {
    let open;
    const holding = await workload(store, config.agentId, config.maxOpenPrs, workspace,
      config.ado, config.legacyBranchPrefixes, async (ado, options) => {
        const prs = await listPullRequests(ado, options);
        open = agentPullRequests(store, config.agentId, prs, config.legacyBranchPrefixes);
        return prs;
      });
    return { holding, open };
  }
  return async () => {
    let state = readJson(file);
    if (state && (state.version !== 1 || !/^[a-f0-9-]{36}$/.test(state.eventId))) {
      throw new Error(`Invalid persisted ${kind} discovery event`);
    }
    let previous;
    if (state) {
      previous = await queue.findSubmission(state.eventId);
      if (state.taskId && previous?.id !== state.taskId) throw new Error(`${policy.label} discovery task receipt is missing or changed`);
      if (previous && !state.taskId) {
        writeJson(file, { ...state, taskId: previous.id });
        return { dispatched: 0, taskId: previous.id, holding: `Recovered the existing ${kind} assignment` };
      }
      if (previous && ["failed", "cancelled"].includes(previous.status)) {
        return { dispatched: 0, taskId: previous.id, holding: `${policy.label} discovery ${previous.status}; inspect the original task before releasing more work` };
      }
    }
    const before = await capacity();
    observe({ openPrs: before.open?.length ?? null, maxOpenPrs: config.maxOpenPrs });
    if (before.holding) return { dispatched: 0, holding: before.holding, openPrs: before.open?.length ?? null, maxOpenPrs: config.maxOpenPrs };
    store.assertIdle(config.agentId, workspace);
    if (!state || previous || state.heldAfterPreparation) {
      state = { version: 1, eventId: randomUUID() };
      writeJson(file, state);
    }
    const prepared = await prepare({
      branch: `${policy.branch}-${state.eventId}`, runSetup: true, runBuild: false, reset: false,
      ...(state.preparation ? { prepared: state.preparation } : {}),
    });
    queue.setPreparation(prepared);
    state = { ...state, preparation: prepared };
    writeJson(file, state);
    const after = await capacity();
    if (after.holding) {
      writeJson(file, { ...state, heldAfterPreparation: true });
      return { dispatched: 0, holding: after.holding, openPrs: after.open?.length ?? null, maxOpenPrs: config.maxOpenPrs };
    }
    store.assertIdle(config.agentId, workspace);
    const prompt = discoveryPrompt(kind, after.open);
    const task = await queue.createIssue({
      title: policy.title, description: prompt,
      assigneeAgentId: config.agentId, submissionId: state.eventId,
      handoff: { discovery: true, maxOpenPrs: config.maxOpenPrs, openPrs: after.open.map(pr => pr.id) },
    });
    const saved = store.task(task.id), metadata = store.metadata(task.id);
    if (saved?.prompt !== prompt || metadata?.preparation?.branch !== prepared.branch ||
        metadata.preparation.commit !== prepared.commit || metadata.preparation.ready !== true) {
      throw new Error(`${policy.label} discovery failed exact prompt/preparation readback`);
    }
    writeJson(file, { ...state, taskId: task.id });
    return { dispatched: 1, taskId: task.id, holding: null, openPrs: after.open.length, maxOpenPrs: config.maxOpenPrs };
  };
}
