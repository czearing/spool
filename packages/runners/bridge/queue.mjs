import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { digest, readJson, samePath, verifiedWorkspaceMigration, writeJson } from "./spool-store.mjs";
import { withHandoffInstructions } from "./managed-settings.mjs";
import { createMonitorControls } from "./monitor-controls.mjs";
import { reviewSupersession, reviewRevisionUpdateMessage, reviewProviderInterrupted } from "../packages/repository-mcp/src/review-outcome.mjs";
import { needsDependencyRepair } from "../scanners/pr-reviewer/lib/dependency-repair.mjs";

const status = { incoming: "todo", in_progress: "in_progress", completed: "done", failed: "failed" };
const deliveryInstructions = [
  "## Spool task delivery",
  "Use spool_update_task_status failed only for a genuine failure, with the exact cause. An ordinary conversation, clarification question or missing status call is not a failure.",
  "A normal successful response defaults to completed. You may record completion explicitly using spool_update_task_status completed; required verification still applies.",
  "Use spool_get_task to inspect or verify the saved result and status.",
  "Use this task only.",
].join("\n");
export function renderSpoolTaskPrompt(description, agent, instructions = "", runner = agent) {
  const prompt = withHandoffInstructions(description, instructions);
  if (runner === "pr-reviewer") return prompt;
  return `${prompt}\n\n${deliveryInstructions} Do not post PR comments.`;
}
export function issueFromTask(task, metadata = {}) {
  const supersession = reviewSupersession(task, metadata);
  const prepared = metadata?.preparation;
  const dependencyRepairPending = (metadata?.runner === "pr-reviewer" || metadata?.source === "pr-reviewer") &&
    task.status === "failed" && task.interaction?.phase === "ended" && !task.provider &&
    !task.interaction.paused && !task.interaction.cancel_requested &&
    !task.interaction.messages?.some(message => ["queued", "delivering", "delivery_uncertain"].includes(message.status)) &&
    prepared?.ready && prepared.branch && /^[a-f0-9]{40}$/i.test(prepared.commit || "") &&
    task.prompt?.split("\n").some(line => line.trim() === `Source commit: ${prepared.commit}`) &&
    prepared.execution?.kind !== "codespace" && !prepared.dependencyRepair && needsDependencyRepair(task.error);
  let title = task.title;
  const legacyReview = /^pr-review-(\d+)$/.exec(task.id);
  if (legacyReview) title = `Review Azure DevOps pull request #${legacyReview[1]}: ${title}`;
  return {
    id: task.id, identifier: task.id, title, description: task.prompt,
    assigneeAgentId: task.agent, assigneeUserId: null,
    status: task.withdrawn || metadata?.cancelled ? "cancelled" : supersession?.status || status[task.status],
    ...(supersession ? { reviewOutcome: supersession } : {}),
    ...(metadata?.preparation?.pr?.targetCommit ? { reviewTargetCommit: metadata.preparation.pr.targetCommit } : {}),
    createdAt: task.created_at, updatedAt: task.updated_at,
    workspace: task.workspace, projectId: "spool",
    ...(task.interaction?.phase ? { executionPhase: task.interaction.phase } : {}),
    ...(task.interaction?.messages?.some(message => message.status === "queued")
      ? { pendingOperatorInput: true } : {}),
    ...(dependencyRepairPending ? { dependencyRepairPending: true } : {}),
    ...(task.error ? { error: task.error } : {}),
  };
}
export function createSpoolQueue(store, { agent, workspace, runner, identity = runner, handoffInstructions = "", verbatimPrompt = false,
  nativeDispatch = false, createControls = createMonitorControls }) {
  const provider = nativeDispatch && readJson(path.join(store.root, "spool.json"))?.copilotProviders?.[agent];
  if (typeof nativeDispatch !== "boolean" || nativeDispatch &&
      (runner !== "perf" || agent !== "perf" || !provider?.command || provider.workingDirectory !== "/workspaces/1JS"))
    throw new Error("Native performance delivery requires its registered assigned provider");
  if (typeof verbatimPrompt !== "boolean" || verbatimPrompt && handoffInstructions.trim()) {
    throw new Error("Verbatim task prompts cannot have appended runner instructions");
  }
  const renderPrompt = description => {
    if (typeof description !== "string" || !description.trim()) throw new Error("Spool task instructions must be nonempty text");
    return verbatimPrompt ? description : renderSpoolTaskPrompt(description, agent, handoffInstructions, runner);
  };
  const convert = task => {
    if (!task) return null;
    const metadata = store.metadata(task.id), issue = issueFromTask(task, metadata);
    return runner === "pr-reviewer" && (task.agent !== agent || !samePath(task.workspace, workspace) ||
      metadata?.runner !== identity) ? { ...issue, retryAllowed: false } : issue;
  };
  const withdrawnRoot = path.join(store.queues, ".runner-withdrawn");
  const withdrawn = id => store.withdrawn(id);
  let preparation = null;
  return {
    async recoverPendingRetries() {
      if (runner !== "pr-reviewer" || !existsSync(store.records)) return;
      for (const name of readdirSync(store.records).filter(name => name.startsWith("task-") && name.endsWith(".json"))) {
        const receipt = readJson(path.join(store.records, name));
        if (receipt?.runner !== identity || receipt.phase !== "pending" || !receipt.retryOf) continue;
        if (receipt.payload?.agent !== agent || !samePath(receipt.payload?.workspace, workspace)) {
          throw new Error("Interrupted reviewer retry belongs to another agent or workspace");
        }
        store.recoverSubmission(receipt.key);
      }
    },
    setPreparation(value) {
      if (runner === "backlog" || nativeDispatch) throw new Error("Native delivery does not prepare agent repositories");
      if (!value?.ready || !value.branch || !value.commit || !samePath(value.repoRoot, workspace)) {
        throw new Error("Spool requires verified Bohemia preparation for the configured workspace");
      }
      preparation = value;
    },
    async listIssues(filter = {}) {
      const archived = existsSync(withdrawnRoot) ? readdirSync(withdrawnRoot).filter(n => n.endsWith(".json"))
        .map(n => withdrawn(n.slice(0, -5))).filter(Boolean) : [];
      return [...store.tasks(), ...archived]
        .filter(task => !filter.assigneeAgentId || task.agent === filter.assigneeAgentId).map(convert);
    },
    async listLiveRuns() { return store.liveTasks().map(task => ({ id: task.id, agentId: task.agent })); },
    async getIssue(id) { return convert(store.task(id) || withdrawn(id)); },
    async findSubmission(submissionId) {
      if (typeof submissionId !== "string" || !submissionId.trim()) throw new Error("Spool submissionId must be a nonempty evidence identity");
      const submitted = store.submission(`${identity}:${digest(submissionId)}`);
      if (!submitted) return null;
      if (submitted.task.agent !== agent || !store.matchesTaskWorkspace(submitted.task, workspace) &&
          !verifiedWorkspaceMigration(store.metadata(submitted.task.id), workspace, submitted.task.workspace)) {
        throw new Error("Existing Spool submission belongs to a different agent or workspace");
      }
      return convert(submitted.task);
    },
    async getComments(id) {
      return (store.task(id)?.comments || []).map(comment => ({ ...comment, body: comment.message || comment.content }));
    },
    async notifyIssue(id, update) {
      const task = store.task(id);
      const metadata = task && store.metadata(id);
      const prId = Number(metadata?.preparation?.pr?.id ?? metadata?.preparation?.prId ??
        /^Review Azure DevOps pull request #(\d+):/.exec(task?.title || "")?.[1]);
      if (runner !== "pr-reviewer" || !task || task.agent !== agent || task.status !== "in_progress" ||
          task.interaction?.paused || metadata?.runner !== identity || prId !== update.prId) return false;
      const message = reviewRevisionUpdateMessage(update);
      const command = digest(`${identity}:revision-update:${id}:${message}`).slice(0, 32)
        .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
      const controls = createControls(store);
      const receipt = controls.receipt(command);
      if (receipt?.result?.status === "failed") throw new Error(receipt.result.error || "Review update delivery failed");
      if (!receipt) controls.submit({ id: command, kind: "message", taskId: id, message });
      return receipt?.result?.status === "accepted";
    },
    submissionEvidence(submissionId) {
      if (typeof submissionId !== "string" || !submissionId.trim()) throw new Error("Spool submissionId must be a nonempty evidence identity");
      return store.receipt(`${identity}:${digest(submissionId)}`);
    },
    async createIssue(issue) {
      if (issue.assigneeAgentId !== agent) throw new Error("Spool runner cannot silently change the configured agent");
      if (runner !== "backlog" && !nativeDispatch && !preparation) throw new Error("Spool handoff requires successful Bohemia preparation");
      if (issue.submissionId !== undefined && (typeof issue.submissionId !== "string" || !issue.submissionId.trim())) {
        throw new Error("Spool submissionId must be a nonempty evidence identity");
      }
      const key = `${identity}:${digest(issue.submissionId ?? `${issue.title}\n${issue.description}`)}`;
      return convert(await store.submit({ key, agent, workspace, title: issue.title,
        prompt: renderPrompt(issue.description),
        metadata: { runner: identity, ...(identity !== runner ? { source: runner } : {}),
          ...(preparation ? { preparation } : {}), ...(issue.handoff ? { handoff: issue.handoff } : {}),
          ...(issue.acceptance ? { acceptance: issue.acceptance } : {}) } }));
    },
    async retryIssue(id, issue, failedAt) {
      if (runner !== "pr-reviewer" || issue.assigneeAgentId !== agent || !preparation) {
        throw new Error("Reviewer retry requires verified preparation and the original reviewer");
      }
      const key = `${identity}:retry:${digest(`${id}:${failedAt}`)}`;
      const existing = store.submission(key);
      if (existing) return convert(existing.task);
      const preparedRestart = preparation.execution?.kind === "codespace";
      const restartId = digest(`reviewer-startup:${key}${preparedRestart ? `:${preparation.leaseToken}` : ""}`).slice(0, 32)
        .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
      const restarted = readJson(path.join(store.root, "controls", "results", `${restartId}.json`));
      if (restarted?.result?.status === "accepted") return convert(store.task(id));
      const previous = store.task(id);
      if (!previous || previous.status !== "failed" || previous.updated_at !== failedAt ||
          previous.agent !== agent || !samePath(previous.workspace, workspace) ||
          store.metadata(id)?.runner !== identity) {
        throw new Error("Failed review changed before continuation; refusing a replacement task");
      }
      const messages = previous.interaction?.messages || [];
      const queuedInput = messages.some(message => message.status === "queued");
      const interrupted = reviewProviderInterrupted(previous.error);
      if (interrupted && (previous.provider || previous.interaction?.paused ||
          !["ended", "waiting_preparation"].includes(previous.interaction?.phase) ||
          messages.some(message => ["delivering", "delivery_uncertain"].includes(message.status))))
        throw new Error("Interrupted reviewer cleanup or message delivery is unconfirmed");
      if ((!previous.session_id || queuedInput) &&
          readJson(path.join(store.root, "spool.json"))?.copilotProviders?.[agent]) {
        if (previous.provider || (!previous.session_id &&
            (previous.turns || previous.session_config || previous.deferred_session || previous.deferred_pr_owner)) ||
            (queuedInput && (!["ended", "waiting_preparation"].includes(previous.interaction.phase) ||
              messages.some(message => ["delivering", "delivery_uncertain"].includes(message.status)))))
          throw new Error("Reviewer startup cleanup or session ownership is unconfirmed");
        const controls = createControls(store);
        const request = { id: restartId, kind: "status", taskId: id,
          status: "in_progress", expectedStatus: "failed" };
        if (preparedRestart) await controls.submitPreparedReviewerRestart(request, preparation);
        else controls.submit(request);
        throw new Error("Waiting for safe restart of the original reviewer task");
      }
      return convert(await store.submit({
        key, agent, workspace, resumeId: id, expectedUpdatedAt: failedAt, title: previous.title,
        prompt: interrupted
          ? "The provider connection was interrupted during this review. Continue this existing task and saved session " +
            "for the assigned PR revision; do not restart the review or repeat completed work. " +
            "First reconcile saved review artifacts, running child agents, in-flight operations, and publication receipts. " +
            "Reuse completed specialist results and verify uncertain outcomes before retrying commands or external actions. " +
            "Preserve the current checkout and existing work. Finish the remaining review and record its verified outcome."
          : renderSpoolTaskPrompt(issue.description, agent, handoffInstructions, runner),
        metadata: { ...store.metadata(id), runner: identity, preparation, retryOf: id, retryFailedAt: failedAt,
          key, phase: undefined, publishedAt: undefined },
      }));
    },
    async cancelIssue(id, reason) {
      const task = store.task(id);
      if (!task) throw new Error(`Spool task is missing: ${id}`);
      const metadata = store.metadata(id);
      // Imported and running work belongs to its existing owner, not to this runner.
      if (metadata?.runner !== identity || task.agent !== agent ||
          task.status !== "incoming" || store.liveTasks().some(t => t.id === id)) return false;
      const archive = path.join(store.queues, ".runner-withdrawn", `${id}.json`);
      mkdirSync(path.dirname(archive), { recursive: true });
      try { renameSync(task.file, archive); }
      catch (error) {
        if (error.code === "ENOENT" && !existsSync(task.file)) return false;
        throw error;
      }
      writeJson(path.join(store.records, `task-${id}.json`), { ...metadata, cancelled: true, reason });
      return true;
    },
  };
}
