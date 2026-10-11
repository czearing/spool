import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { digest, readJson, samePath, writeJson } from "./spool-store.mjs";
import { withHandoffInstructions } from "./managed-settings.mjs";

const status = { incoming: "todo", in_progress: "in_progress", completed: "done", failed: "failed" };
const deliveryInstructions = [
  "## Spool task delivery",
  "Record findings, verification evidence and any resulting PR URL on the current task using spool_add_comment.",
  "Use spool_update_task_status completed only after the required work and evidence are complete. If blocked or unsuccessful, use failed with the exact cause; never claim completion.",
  "Read the task back using spool_get_task to confirm the saved result and status. A final chat response alone does not complete the task.",
  "Use this task only.",
].join("\n");
export function renderSpoolTaskPrompt(description, agent, instructions = "", runner = agent) {
  const adapter = runner === "pr-reviewer"
    ? "\nTask-system adapter only: perform the original Paperclip task comment, status and readback steps on this Spool task using the tools above, not the Paperclip API. All original review, posting, approval and notification instructions remain unchanged."
    : " Do not post PR comments.";
  return `${withHandoffInstructions(description, instructions)}\n\n${deliveryInstructions}${adapter}`;
}
export function issueFromTask(task, metadata = {}) {
  let title = task.title;
  const legacyReview = /^pr-review-(\d+)$/.exec(task.id);
  if (legacyReview) title = `Review Azure DevOps pull request #${legacyReview[1]}: ${title}`;
  return {
    id: task.id, identifier: task.id, title, description: task.prompt,
    assigneeAgentId: task.agent, assigneeUserId: null,
    status: task.withdrawn || metadata?.cancelled ? "cancelled" : status[task.status],
    createdAt: task.created_at, updatedAt: task.updated_at,
    workspace: task.workspace, projectId: "spool",
    ...(task.error ? { error: task.error } : {}),
  };
}
export function createSpoolQueue(store, { agent, workspace, runner, identity = runner, handoffInstructions = "", verbatimPrompt = false }) {
  if (typeof verbatimPrompt !== "boolean" || verbatimPrompt && handoffInstructions.trim()) {
    throw new Error("Verbatim task prompts cannot have appended runner instructions");
  }
  const renderPrompt = description => {
    if (typeof description !== "string" || !description.trim()) throw new Error("Spool task instructions must be nonempty text");
    return verbatimPrompt ? description : renderSpoolTaskPrompt(description, agent, handoffInstructions, runner);
  };
  const convert = task => task ? issueFromTask(task, store.metadata(task.id)) : null;
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
      if (submitted.task.agent !== agent || !samePath(submitted.task.workspace, workspace)) {
        throw new Error("Existing Spool submission belongs to a different agent or workspace");
      }
      return convert(submitted.task);
    },
    async getComments(id) {
      return (store.task(id)?.comments || []).map(comment => ({ ...comment, body: comment.message || comment.content }));
    },
    async createIssue(issue) {
      if (issue.assigneeAgentId !== agent) throw new Error("Spool runner cannot silently change the configured agent");
      if (!preparation) throw new Error("Spool handoff requires successful Bohemia preparation");
      if (issue.submissionId !== undefined && (typeof issue.submissionId !== "string" || !issue.submissionId.trim())) {
        throw new Error("Spool submissionId must be a nonempty evidence identity");
      }
      const key = `${identity}:${digest(issue.submissionId ?? `${issue.title}\n${issue.description}`)}`;
      return convert(await store.submit({ key, agent, workspace, title: issue.title,
        prompt: renderPrompt(issue.description),
        metadata: { runner: identity, ...(identity !== runner ? { source: runner } : {}), preparation, ...(issue.handoff ? { handoff: issue.handoff } : {}),
          ...(issue.acceptance ? { acceptance: issue.acceptance } : {}) } }));
    },
    async retryIssue(id, issue, failedAt) {
      if (runner !== "pr-reviewer" || issue.assigneeAgentId !== agent || !preparation) {
        throw new Error("Reviewer retry requires verified preparation and the original reviewer");
      }
      const key = `${identity}:retry:${digest(`${id}:${failedAt}`)}`;
      const existing = store.submission(key);
      if (existing) return convert(existing.task);
      const previous = store.task(id);
      if (!previous || previous.status !== "failed" || previous.updated_at !== failedAt ||
          previous.agent !== agent || !samePath(previous.workspace, workspace) ||
          store.metadata(id)?.runner !== identity) {
        throw new Error("Failed review changed before continuation; refusing a replacement task");
      }
      const role = path.join(store.root, "agents", `${agent}.md`);
      const description = `${issue.description}\n\nBefore continuing, read the current reviewer role at ${role}. Its current instructions supersede older reviewer instructions retained in this session. Preserve completed work and verified external actions.`;
      return convert(await store.submit({
        key, agent, workspace, resumeId: id, expectedUpdatedAt: failedAt, title: previous.title,
        prompt: renderSpoolTaskPrompt(description, agent, handoffInstructions, runner),
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
