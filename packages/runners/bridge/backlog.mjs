import path from "node:path";
import { publicationForTask } from "./publications.mjs";
import { readJson, samePath, verifiedWorkspaceMigration, writeJson } from "./spool-store.mjs";
import { workload, agentPullRequests } from "./workload.mjs";
import { assignedChild, createBacklogClient, orderWorkItems, prArtifacts, sameArtifact } from "./backlog-ado.mjs";
import { reconcileBacklogEntry, verifyBacklogPr } from "./backlog-lifecycle.mjs";
import { settleCompletedNativeTurn } from "./native-turn-settlement.mjs";
import { verifyEngineeringCodespace } from "../packages/repository-mcp/src/codespaces/engineering.mjs";
import { recoverNativeInvestigation } from "./native-investigation-recovery.mjs";
import { reconcileBlockedBacklog } from "./backlog-blocked.mjs";
import { recoverNativePublication } from "./native-publication-recovery.mjs";

export const backlogPrompt = (url, reviewers) =>
  `Investigate this work item ${url} in midgard/packages/library-module-exp-homepage/src/unified-library, not the standalone TanStack app. Create a PR, attach it to the work item, and assign ${reviewers.map(reviewer => reviewer.name).join(", ")} as reviewers.`;

export function createBacklogScan({ store, config, queue, workspace, runtime,
  client = createBacklogClient(config), observe = () => {},
  verifyCoveredWorkspace = async (task, pr) => {
    const root = store.workspaceIdentity(task.agent, task.workspace, task.session_config?.provider);
    const prepared = readJson(path.join(root, "preparation.json"));
    const current = await verifyEngineeringCodespace(prepared, { allowWork: true });
    return current.commit === pr.lastMergeSourceCommit?.commitId &&
      `refs/heads/${current.branch}` === pr.sourceRefName && current.worktreeStatus === "";
  } }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.agentId || "") || !Number.isSafeInteger(config.maxOpenPrs) ||
      config.maxOpenPrs < 1 || config.maxOpenPrs > 5 || !Number.isSafeInteger(config.parentWorkItem) ||
      config.parentWorkItem < 1 || !config.legacyBranchPrefixes?.length || !config.reviewers?.length)
    throw new Error("Backlog requires an agent, a parent work item, verified reviewers and a 1–5 PR cap");
  const file = path.join(runtime, "backlog.json");
  const scope = { organization: config.ado.organization, project: config.workItemProject,
    parent: config.parentWorkItem, repository: config.ado.repository, repositoryProject: config.ado.projectId,
    creator: config.ado.creatorId, assignee: config.ado.authorAccount, agent: config.agentId, workspace };
  async function capacity() {
    let open;
    const holding = await workload(store, config.agentId, config.maxOpenPrs, workspace, config.ado,
      config.legacyBranchPrefixes, async (ado, options) => {
        const prs = await client.listPullRequests(ado, options);
        open = agentPullRequests(store, config.agentId, prs, config.legacyBranchPrefixes);
        return prs;
      });
    return { holding, openPrs: open?.length ?? null, maxOpenPrs: config.maxOpenPrs };
  }
  return async () => {
    const state = readJson(file) || { version: 2, scope, entries: [] };
    if (state.version !== 2 || JSON.stringify(state.scope) !== JSON.stringify(scope) || !Array.isArray(state.entries) ||
        state.entries.some(entry => !Number.isSafeInteger(entry.itemId) || entry.itemId < 1 ||
          entry.eventId !== `work-item:${config.workItemProject}:${config.parentWorkItem}:${entry.itemId}`) ||
        new Set(state.entries.map(entry => entry.itemId)).size !== state.entries.length)
      throw new Error("Backlog state ownership/identity changed; inspect before continuing");
    const save = () => writeJson(file, state);
    const activate = async entry => {
      await client.activate(await client.item(entry.itemId));
      entry.activatedAt = new Date().toISOString();
      delete entry.activationPending;
      save();
    };
    let holding;
    for (const entry of state.entries.filter(entry => !entry.closedAt)) {
      const task = await queue.findSubmission(entry.eventId);
      if (entry.taskId && task?.id !== entry.taskId) throw new Error("Backlog task receipt is missing or changed");
      if (!task) continue;
      if (!entry.taskId) { entry.taskId = task.id; save(); }
      const metadata = queue.submissionEvidence(entry.eventId), saved = store.task(task.id);
      if (metadata?.handoff?.workItem?.id !== entry.itemId ||
          metadata.handoff.workItem.project !== config.workItemProject ||
          metadata.handoff.workItem.parent !== config.parentWorkItem ||
          saved?.agent !== config.agentId || !store.matchesTaskWorkspace(saved, workspace) &&
          !verifiedWorkspaceMigration(store.metadata(task.id), workspace, saved?.workspace))
        throw new Error("Backlog task/work-item readback changed");
      if (entry.activationPending === true) await activate(entry);
      const publication = publicationForTask(store, task.id, { branch: metadata.preparation?.branch });
      if (publication) {
        if (publication.verified !== true || !["spool", "mcp"].includes(publication.originKind) ||
            publication.taskId !== task.id || publication.agent !== saved.agent ||
            publication.sessionId !== saved.session_id || !store.matchesTaskWorkspace(saved, publication.workspace) ||
            !/^[1-9]\d*$/.test(publication.prId || "") || !publication.branch ||
            entry.branch && entry.branch !== publication.branch ||
            entry.prId && entry.prId !== Number(publication.prId))
          throw new Error("Backlog verified PR publication ownership changed");
        entry.branch = publication.branch;
        entry.prId = Number(publication.prId);
        save();
      }
      let covered = false;
      if (!publication && config.repositoryProfile === "1js" && saved.status === "failed" && !saved.provider) {
        const item = await client.item(entry.itemId);
        if (assignedChild(config, item) && await client.isOpen(item)) {
          for (const owner of state.entries.filter(other => other !== entry && other.prId && other.branch)) {
            const published = publicationForTask(store, owner.taskId, { prId: owner.prId, branch: owner.branch });
            const original = store.task(owner.taskId);
            const ownership = original && store.metadata(original.id);
            if (!original || original.agent !== saved.agent || !store.matchesTaskWorkspace(original, workspace) &&
                !verifiedWorkspaceMigration(ownership, workspace, original.workspace) ||
                published?.verified !== true || !["spool", "mcp"].includes(published.originKind) ||
                published.taskId !== owner.taskId || published.taskId !== original.id || published.agent !== saved.agent ||
                published.sessionId !== original.session_id || !store.matchesTaskWorkspace(original, published.workspace) &&
                !verifiedWorkspaceMigration(ownership, published.workspace, original.workspace) ||
                published.branch !== owner.branch || Number(published.prId) !== owner.prId) continue;
            const repo = await client.repository(), pr = await client.getPr(owner.prId);
            verifyBacklogPr(config, owner, repo, pr);
            if (!prArtifacts(item).some(link => sameArtifact(link.url, client.artifact(repo, pr)))) continue;
            if (entry.coveredByTaskId && entry.coveredByTaskId !== owner.taskId)
              throw new Error("Covered work-item publication ownership changed");
            if (!entry.coveredByTaskId && !await verifyCoveredWorkspace(saved, pr)) continue;
            Object.assign(entry, { branch: owner.branch, prId: owner.prId, coveredByTaskId: owner.taskId });
            covered = true;
            save();
            break;
          }
        }
      }
      const settlement = await reconcileBacklogEntry({ config, entry, client, save });
      if (settlement.closed || settlement.retired) continue;
      holding ||= settlement.holding;
      const finished = await settleCompletedNativeTurn({ store, config, task: saved, workspace });
      if (finished) return finished;
      if (["failed", "cancelled"].includes(task.status)) {
        if (covered && settlement.hasPr && !settlement.holding) continue;
        if (config.repositoryProfile === "1js" && publication && settlement.hasPr && !settlement.holding &&
            saved.status === "failed" && !saved.acceptance && !saved.provider &&
            saved.interaction?.phase === "ended" &&
            !saved.interaction.messages?.some(message => message.status !== "delivered")) {
          const followup = store.metadata(task.id);
          if (followup?.runner === "pr-updater" && followup.creator?.taskId === task.id &&
              String(followup.contract?.prId) === String(entry.prId)) continue;
        }
        if (await reconcileBlockedBacklog({ store, config, task: saved, workspace, entry, client, save })) continue;
        const publicationRetry = await recoverNativePublication({ store, config, task: saved, workspace, entry, client, capacity });
        if (publicationRetry) return publicationRetry;
        const revisited = await recoverNativeInvestigation({ store, config, task: saved, workspace, capacity });
        if (revisited) return revisited;
        holding ||= `Backlog task ${task.id} ${task.status}; inspect the original task before releasing more work`;
      }
      if (task.status === "done" && !settlement.hasPr)
        holding ||= `Completed backlog task ${task.id} has no verified PR; inspect before releasing more work`;
    }
    const before = await capacity();
    observe(before);
    if (holding || before.holding) return { dispatched: 0, ...before, holding: holding || before.holding };
    store.assertIdle(config.agentId, workspace);
    const candidates = orderWorkItems(await client.list());
    const assignedItems = new Set(store.tasks().map(task => store.metadata(task.id)?.handoff?.workItem)
      .filter(item => item?.project === config.workItemProject && item.parent === config.parentWorkItem)
      .map(item => item.id));
    observe({ backlogItems: candidates.length });
    let item, entry;
    for (const candidate of candidates) {
      const existing = state.entries.find(entry => entry.itemId === candidate.id);
      if (existing?.taskId || existing?.closedAt || assignedItems.has(candidate.id)) continue;
      const current = await client.item(candidate.id);
      if (!assignedChild(config, current) || !await client.isOpen(current) || prArtifacts(current).length) continue;
      item = current;
      entry = existing;
      break;
    }
    if (!item) return { dispatched: 0, ...before, holding: "No eligible unassigned backlog work remains" };
    await client.verifyReviewers();
    await client.repository();
    if (!entry) {
      entry = { itemId: item.id, eventId: `work-item:${config.workItemProject}:${config.parentWorkItem}:${item.id}` };
      state.entries.push(entry);
      save();
    }
    const after = await capacity();
    if (after.holding) return { dispatched: 0, ...after };
    item = await client.item(item.id);
    if (!assignedChild(config, item) || !await client.isOpen(item) || prArtifacts(item).length)
      return { dispatched: 0, ...after, holding: `Work item ${item.id} eligibility changed before delivery` };
    store.assertIdle(config.agentId, workspace);
    const prompt = backlogPrompt(client.itemUrl(item.id), config.reviewers);
    entry.activationPending = true;
    save();
    const task = await queue.createIssue({ title: `Work item ${item.id}: ${item.title}`, description: prompt,
      assigneeAgentId: config.agentId, submissionId: entry.eventId,
      handoff: { workItem: { id: item.id, project: config.workItemProject, parent: config.parentWorkItem },
        maxOpenPrs: config.maxOpenPrs } });
    const saved = store.task(task.id), metadata = store.metadata(task.id);
    if (saved?.prompt !== prompt || saved.agent !== config.agentId || !samePath(saved.workspace, workspace) ||
        metadata?.preparation !== undefined ||
        metadata.handoff?.workItem?.id !== item.id) throw new Error("Backlog exact prompt/preparation readback failed");
    entry.taskId = task.id;
    save();
    await activate(entry);
    return { dispatched: 1, taskId: task.id, workItemId: item.id, ...after };
  };
}
