import { prepareRepositorySession } from "../packages/repository-mcp/src/client.mjs";
import { verifySavedCodespace } from "../packages/repository-mcp/src/codespaces/review.mjs";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { queuedOperatorChat, readJson } from "./spool-store.mjs";
import { queuedOperatorMessage } from "./spool-files.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { recoveryCommandId } from "./control-identity.mjs";
import { codespaceConnectionFailure } from "../packages/repository-mcp/src/codespaces/github-requests.mjs";

export function codespaceReviewPending(store, agent) {
  return store.tasks().some(task => {
    if (task.agent !== agent || !["incoming", "failed"].includes(task.status) || task.interaction?.paused ||
        !(queuedOperatorChat(task) || queuedOperatorMessage(store.root, task))) return false;
    const message = task.interaction.messages.findLast(message => message.status === "queued");
    const startup = /^Copilot ACP startup failed:/.test(task.error || "") && !!codespaceConnectionFailure(task.error);
    const id = recoveryCommandId(task, message, startup);
    return readJson(path.join(store.root, "controls", "manual", `${id}.json`))?.status !== "failed" &&
      readJson(path.join(store.root, "controls", "results", `${id}.json`))?.result?.status !== "failed";
  });
}

export function codespaceReviewInUse(store, agent) {
  const tasks = store.tasks();
  const live = store.liveTasks(tasks), liveIds = new Set(live.map(task => task.id));
  const ownLease = task => queuedOperatorMessage(store.root, task) &&
    (task.interaction?.phase === "starting" ||
      ["incoming", "failed"].includes(task.status) && !liveIds.has(task.id));
  if (tasks.some(task => task.agent === agent && task.status === "incoming" && !ownLease(task)) ||
      live.some(task => task.agent === agent && !ownLease(task))) return true;
  if (!store.root) return false;
  const pending = path.join(store.root, "controls", "manual");
  return existsSync(pending) && readdirSync(pending).some(name => {
    const job = readJson(path.join(pending, name)), request = job?.request;
    return job?.status !== "failed" && request?.kind === "status" && request.agent === agent &&
      request.expectedStatus === "failed" && ["incoming", "in_progress"].includes(request.status) &&
      tasks.some(task => task.id === request.taskId && task.agent === agent && task.status === "failed" && !ownLease(task));
  });
}

export function codespaceReviewer(config, dependencies = {}) {
  const open = dependencies.prepareSession || prepareRepositorySession;
  let session;
  const release = async () => {
    const owned = session;
    session = undefined;
    if (owned) await owned.close();
  };
  return {
    async prepare({ prId, sourceCommit, repoRoot = config.workspace }) {
      await release();
      if (!config.repositoryMcpConfig && !dependencies.prepareSession)
        throw new Error("Codespace reviewer requires its registered repository MCP configuration");
      const id = Number(prId);
      if (!Number.isSafeInteger(id) || id < 1 || !/^[a-f0-9]{40}$/i.test(sourceCommit || ""))
        throw new Error("Codespace reviewer requires an exact queued PR identity");
      session = await open("1js", {
        repoRoot, operation: "branch", mode: "checkout", reviewPullRequestId: id,
        branch: `review/pr-${id}-${sourceCommit.slice(0, 12)}`, sourceCommit,
        reset: false, mergeMaster: false, runSetup: true, runBuild: true,
      }, { env: { REPOSITORY_MCP_CONFIG: config.repositoryMcpConfig } });
      const prepared = session.result?.structuredContent;
      if (!prepared?.ready || prepared.repoRoot !== repoRoot || prepared.commit !== sourceCommit) {
        await release();
        throw new Error("Reviewer repo_prepare did not verify the queued PR in its registered workspace");
      }
      return prepared;
    },
    verify: dependencies.verify || verifySavedCodespace,
    async drain(store, agent, recover) {
      while (session && codespaceReviewInUse(store, agent)) {
        await recover?.();
        await (dependencies.delay || delay)(1000);
      }
      await release();
    },
    dispose: release,
  };
}
