import { randomUUID } from "node:crypto";
import path from "node:path";
import { readJson, writeJson } from "./spool-store.mjs";
import { agentPullRequests, workload } from "./workload.mjs";
import { listOwnPullRequests } from "../scanners/pr-updater/lib/azure-devops.mjs";

export function performanceDiscoveryPrompt(prs = []) {
  const ids = prs.map(pr => String(pr.id)).sort((a, b) => Number(a) - Number(b));
  if (ids.some(id => !/^\d+$/.test(id))) throw new Error("Performance discovery requires numeric PR identities");
  const distinct = ids.length ? `PR${ids.length === 1 ? "" : "s"} ${ids.join(", ")}` : "existing open PRs";
  return `Find and implement one more small, safe New Office production-performance improvement distinct from ${distinct}, proving a real production cost reduction and preserved behavior before publishing.`;
}

export function createPerformanceScan({ store, config, queue, workspace, runtime, prepare,
  listPullRequests = listOwnPullRequests, observe = () => {} }) {
  if (config.agentId !== "perf" || !Number.isSafeInteger(config.maxOpenPrs) ||
      config.maxOpenPrs < 1 || config.maxOpenPrs > 3 || !config.legacyBranchPrefixes?.length) {
    throw new Error("Performance discovery requires the perf agent, PR ownership prefixes, and an open PR cap from 1 to 3");
  }
  const file = path.join(runtime, "perf-discovery.json");
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
      throw new Error("Invalid persisted performance discovery event");
    }
    let previous;
    if (state) {
      previous = await queue.findSubmission(state.eventId);
      if (state.taskId && previous?.id !== state.taskId) throw new Error("Performance discovery task receipt is missing or changed");
      if (previous && !state.taskId) {
        writeJson(file, { ...state, taskId: previous.id });
        return { dispatched: 0, taskId: previous.id, holding: "Recovered the existing performance assignment" };
      }
      if (previous && ["failed", "cancelled"].includes(previous.status)) {
        return { dispatched: 0, taskId: previous.id, holding: `Performance discovery ${previous.status}; inspect the original task before releasing more work` };
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
      branch: `new-office-perf-${state.eventId}`, runSetup: true, runBuild: false, reset: false,
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
    const prompt = performanceDiscoveryPrompt(after.open);
    const task = await queue.createIssue({
      title: "Another safe New Office production improvement", description: prompt,
      assigneeAgentId: config.agentId, submissionId: state.eventId,
      handoff: { discovery: true, maxOpenPrs: config.maxOpenPrs, openPrs: after.open.map(pr => pr.id) },
    });
    const saved = store.task(task.id), metadata = store.metadata(task.id);
    if (saved?.prompt !== prompt || metadata?.preparation?.branch !== prepared.branch ||
        metadata.preparation.commit !== prepared.commit || metadata.preparation.ready !== true) {
      throw new Error("Performance discovery failed exact prompt/preparation readback");
    }
    writeJson(file, { ...state, taskId: task.id });
    return { dispatched: 1, taskId: task.id, holding: null, openPrs: after.open.length, maxOpenPrs: config.maxOpenPrs };
  };
}
