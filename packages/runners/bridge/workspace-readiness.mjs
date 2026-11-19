import path from "node:path";
import { readJson, samePath, SpoolStore } from "./spool-store.mjs";
import { publishOnce } from "./spool-files.mjs";
import { prepareRepositorySession } from "../packages/repository-mcp/src/client.mjs";

export function workspaceRequirement(store, agent, profile, configFile) {
  const declared = readJson(path.join(store.root, "spool.json"))?.workspacePreparations?.[agent];
  if (declared !== undefined) {
    if (!declared || typeof declared.repo !== "string" || !declared.repo ||
        !path.isAbsolute(declared.input?.repoRoot || "") ||
        !path.isAbsolute(declared.mcpConfig || ""))
      throw new Error("Workspace preparation requires a repository, absolute repoRoot and repository MCP configuration");
    return declared;
  }
  if (!profile || profile.purpose !== "review" &&
      !(profile.purpose === undefined && profile.codespace && profile.remoteRoot)) return null;
  const runner = readJson(path.join(store.root, ".runner", "automation", "spool-runners.json"));
  if (!runner && !profile.workspace) return null;
  if (!samePath(runner?.codespace_review_config, configFile) ||
      !path.isAbsolute(runner?.repository_mcp_config || "") ||
      !path.isAbsolute(profile.workspace || ""))
    throw new Error("No repository preparation is configured for this workspace");
  return { repo: runner.repository_profile, mcpConfig: runner.repository_mcp_config,
    input: { repoRoot: profile.workspace }, reviewConfig: configFile };
}

export function taskWorkspaceRequirement(root, agent, workspace, prompt) {
  const provider = readJson(path.join(root, "spool.json"))?.copilotProviders?.[agent];
  const args = provider?.args || [], index = args.indexOf("--config");
  const configFile = index >= 0 ? args[index + 1] : undefined;
  const requirement = workspaceRequirement({ root }, agent, configFile ? readJson(configFile) : null, configFile);
  return requirement?.reviewConfig && !hasReviewRequest(null, { prompt }) ? null : requirement;
}

export async function stageWorkspaceTask(root, draft) {
  const { createMonitorControls } = await import("./monitor-controls.mjs");
  const controls = createMonitorControls(new SpoolStore(root));
  const request = controls.stage({ id: draft.requestId, kind: "create", agent: draft.agent,
    title: draft.title, prompt: draft.prompt }, { verbatim: true });
  publishOnce(path.join(root, "controls", "manual", `${draft.requestId}.json`), {
    request, requiresPreparation: true, status: "waiting", detail: "Waiting for workspace preparation",
  });
}

function reviewIds(task, request) {
  return [...(task?.prompt ?? request.prompt ?? "").matchAll(
    /https:\/\/(?:dev\.azure\.com\/office\/Office|office\.visualstudio\.com\/Office)\/\\?_git\/1JS\/pullrequest\/(\d+)\b/gi,
  )].map(match => Number(match[1]));
}

export function hasReviewRequest(task, request) {
  return reviewIds(task, request).length > 0;
}

function requestedReview(task, request, expected) {
  const ids = new Set(reviewIds(task, request));
  const assigned = expected?.pr?.id ?? expected?.prId;
  if (assigned !== undefined) ids.add(Number(assigned));
  if (ids.size !== 1 || !Number.isSafeInteger([...ids][0]) || [...ids][0] < 1)
    throw new Error("Workspace preparation needs one unambiguous PR URL for the configured repository");
  return [...ids][0];
}

export function createWorkspaceReadiness(store, {
  prepareSession = prepareRepositorySession,
  createReviewer = async config => (await import("./codespace-reviewer.mjs")).codespaceReviewer(config),
  readReview = async (configFile, id) => {
    const { CodespaceReview } = await import("../packages/repository-mcp/src/codespaces/review.mjs");
    return new CodespaceReview(configFile).readPr(id);
  },
  verify = async prepared => (await import("./workflow-workspace.mjs")).verifyEventWorkspace(prepared),
  alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  },
} = {}) {
  const owned = new Map();
  async function releaseIdle() {
    for (const [id, session] of owned) {
      const task = store.task(session.taskId);
      if (task && (task.status === "incoming" || store.liveTasks([task]).length)) continue;
      const result = readJson(path.join(store.root, "controls", "results", `${id}.json`));
      if (!result) continue;
      await session.close();
      owned.delete(id);
    }
  }
  return {
    releaseIdle,
    async dispose() {
      for (const [id, session] of owned) {
        await session.close();
        owned.delete(id);
      }
    },
    async ensure(requirement, { request, task, expected, progress }) {
      if (!requirement) return {};
      const workspace = requirement.input.repoRoot;
      if (!samePath(workspace, request.workspace))
        throw new Error("Preparation must preserve the assigned workspace");
      const saved = readJson(path.join(workspace, "preparation.json"));
      const prId = requirement.reviewConfig ? requestedReview(task, request, expected) : undefined;
      if (requirement.reviewConfig && task?.session_id && !expected) {
        if (Number(saved?.pr?.id ?? saved?.prId) !== prId || !saved?.commit || !saved.branch)
          throw new Error("The original review preparation is missing; refusing to move its existing session");
        expected = saved;
      }
      const pinned = requirement.reviewConfig ? expected : undefined;
      if (expected && (!samePath(expected.repoRoot, workspace) ||
          expected.pr?.id !== undefined && Number(expected.pr.id) !== prId && requirement.reviewConfig))
        throw new Error("Preparation must preserve the original task's repository and PR");
      const matches = requirement.reviewConfig && saved?.ready &&
        samePath(saved.execution?.configFile, requirement.reviewConfig) &&
        (!prId || Number(saved.pr?.id ?? saved.prId) === prId) &&
        (!pinned?.commit || saved.commit === pinned.commit) &&
        (!pinned?.branch || saved.branch === pinned.branch) &&
        (!requirement.input.sourceCommit || saved.commit === requirement.input.sourceCommit) &&
        (!requirement.input.branch || saved.branch === requirement.input.branch);
      if (matches) {
        await verify(saved);
        return { preparation: saved };
      }
      if (saved?.status === "preparing" || saved?.status !== "stopped" && Number.isSafeInteger(saved?.ownerPid) &&
          saved.ownerPid > 0 && alive(saved.ownerPid))
        return { waiting: saved?.stage ? `Waiting for workspace preparation: ${saved.stage}`
          : "Waiting for the workspace preparation owner to release the repository" };
      progress("Preparing repository through its configured MCP");
      let session, prepared;
      try {
        if (requirement.reviewConfig) {
          const pr = await readReview(requirement.reviewConfig, prId);
          if (expected?.commit && pr.sourceCommit !== expected.commit)
            throw new Error("The original review revision changed; a new review assignment is required");
          const reviewer = await createReviewer({ codespaceReviewConfig: requirement.reviewConfig,
            repositoryMcpConfig: requirement.mcpConfig, workspace });
          session = { close: () => reviewer.dispose() };
          prepared = await reviewer.prepare({ prId, sourceCommit: expected?.commit ?? pr.sourceCommit,
            repoRoot: workspace });
        } else {
          session = await prepareSession(requirement.repo, requirement.input, {
            env: { REPOSITORY_MCP_CONFIG: requirement.mcpConfig },
            onProgress: update => { if (update.message) progress(update.message); },
          });
          prepared = session.result?.structuredContent;
        }
        if (!prepared?.ready || !samePath(prepared.repoRoot, workspace) ||
            !prepared.commit || !prepared.branch ||
            pinned?.commit && prepared.commit !== pinned.commit ||
            pinned?.branch && prepared.branch !== pinned.branch ||
            prId && Number(prepared.pr?.id ?? prepared.prId) !== prId ||
            requirement.input.sourceCommit && prepared.commit !== requirement.input.sourceCommit ||
            requirement.input.branch && prepared.branch !== requirement.input.branch)
          throw new Error("Repository preparation did not verify the required workspace revision");
        await verify(prepared);
        owned.set(request.id, { ...session, taskId: request.taskId });
        return { preparation: prepared };
      } catch (error) {
        if (session) await session.close();
        throw error;
      }
    },
  };
}
