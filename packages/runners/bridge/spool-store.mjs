import { safeId, digest, samePath, verifiedWorkspaceMigration, readJson, writeJson } from "./spool-files.mjs";
import { existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { windowsProcesses } from "../packages/bohemia-agent-tooling/src/windows-processes.js";
import { submit } from "./spool-submission.mjs";
import { nativeReceipt, recoverNativeCommand } from "./native-continuation.mjs";
import { queueStates as states, readTaskRecord as readTask, readQueuedTask, readQueuedTasks } from "./task-records.mjs";

export const queuedOperatorChat = task => !!task?.interaction?.chat_return &&
  task.interaction.messages?.some(message => message.status === "queued");
export { safeId, digest, canonicalPath, samePath, verifiedWorkspaceMigration, readJson, writeJson } from "./spool-files.mjs";

export class SpoolStore {
  constructor(root, { processes = windowsProcesses, publish = linkSync } = {}) {
    this.root = path.resolve(root);
    this.queues = path.join(this.root, "queues");
    this.records = path.join(this.root, ".runner-receipts");
    this.processes = processes;
    this.publish = publish;
    if (!existsSync(path.join(this.root, "agents"))) throw new Error(`Spool agents directory is missing: ${this.root}`);
    for (const state of states) {
      if (!existsSync(path.join(this.queues, state))) throw new Error(`Spool queue is missing: ${state}`);
    }
  }
  validateAgent(agent) {
    safeId(agent);
    if (!existsSync(path.join(this.root, "agents", `${agent}.md`))) throw new Error(`Unknown Spool agent: ${agent}`);
  }
  tasks() { return readQueuedTasks(this.queues); }
  task(id) { return readQueuedTask(this.queues, id); }
  withdrawn(id) {
    const task = readTask(path.join(this.queues, ".runner-withdrawn", `${safeId(id)}.json`), "incoming");
    return task ? { ...task, withdrawn: true } : null;
  }
  liveTasks(tasks = this.tasks()) {
    const sessions = tasks.filter(task => task.session_id || task.provider?.token);
    const processes = sessions.length ? this.processes() : [];
    return tasks.filter(task => task.status === "in_progress" || (
      processes.some(p => /^(copilot|node|cmd)(\.exe)?$/i.test(p.Name) &&
        [task.provider?.token, task.session_id].some(identity => identity && p.CommandLine?.includes(identity)))));
  }
  nativeWorkspace(agent, provider) {
    if (!agent || provider === null) return null;
    const registered = readJson(path.join(this.root, "spool.json"))?.copilotProviders?.[agent];
    if (!registered || provider && JSON.stringify(provider) !== JSON.stringify(registered) ||
        registered.workingDirectory !== "/workspaces/1JS") return null;
    const args = registered.args;
    const index = Array.isArray(args) ? args.indexOf("--config") : -1;
    if (index < 0 || !path.isAbsolute(args[index + 1] || "") ||
        !args.some(value => /(?:^|[\\/])codespaces[\\/]copilot\.mjs$/.test(value))) return null;
    const config = readJson(args[index + 1]);
    return ["engineering", "review"].includes(config?.purpose) && config.remoteRoot === registered.workingDirectory &&
      path.isAbsolute(config.workspace || "") ? config : null;
  }
  workspaceIdentity(agent, workspace, provider) {
    if (!samePath(workspace, this.root)) return workspace;
    const config = this.nativeWorkspace(agent, provider);
    return config?.purpose === "engineering" ? config.workspace : workspace;
  }
  ensureControlWorkspace(agent, workspace, provider) {
    const config = this.nativeWorkspace(agent, provider);
    if (config && samePath(config.workspace, workspace)) mkdirSync(config.workspace, { recursive: true });
  }
  ownsWorkspace(task, agent, workspace) {
    const requested = this.workspaceIdentity(agent, workspace);
    const owned = this.workspaceIdentity(task.agent, task.workspace,
      task.session_id ? task.session_config?.provider ?? null : undefined);
    return samePath(requested, owned) || samePath(task.workspace, workspace) &&
      (samePath(requested, workspace) || samePath(owned, task.workspace));
  }
  matchesTaskWorkspace(task, workspace) {
    return samePath(task.workspace, workspace) || samePath(task.workspace,
      this.workspaceIdentity(task.agent, workspace, task.session_id ? task.session_config?.provider ?? null : undefined));
  }
  assertIdle(agent, workspace, exceptId = null, independent = null, { allowPaused = false } = {}) {
    if (agent !== null) this.validateAgent(agent);
    if (agent !== null && !allowPaused && this.isPaused(agent)) throw new Error(`Spool agent ${agent} is paused by operator`);
    if (!path.isAbsolute(workspace)) throw new Error("Spool workspace must be absolute");
    if (independent && (!independent.taskId || !independent.sessionId)) {
      throw new Error("Independent continuation requires its original task and session");
    }
    const holds = path.join(this.root, "controls", "workspace-holds");
    if (existsSync(holds)) {
      for (const name of readdirSync(holds).filter(name => name.endsWith(".json"))) {
        const hold = readJson(path.join(holds, name));
        if (!hold) continue;
        if (typeof hold.taskId !== "string" || typeof hold.agent !== "string" || typeof hold.workspace !== "string") {
          throw new Error(`Invalid workspace reservation: ${name}`);
        }
        if (hold.taskId !== exceptId && ((independent ? hold.taskId === independent.taskId : hold.agent === agent) ||
            this.ownsWorkspace(hold, agent, workspace))) {
          throw new Error(`Workspace/agent is reserved for ${hold.taskId}; preparation held`);
        }
      }
    }
    const tasks = this.tasks(), live = new Set(this.liveTasks(tasks).map(task => task.id));
    const owner = tasks.find(task => ((independent
      ? task.id === independent.taskId || task.session_id === independent.sessionId
      : task.agent === agent) || this.ownsWorkspace(task, agent, workspace)) &&
      (live.has(task.id) || (task.id !== exceptId && ["incoming", "in_progress"].includes(task.status))));
    if (owner) throw new Error(`Workspace/agent is owned by Spool task ${owner.id}; preparation held`);
  }
  isPaused(agent) {
    safeId(agent);
    try { statSync(path.join(this.root, "controls", "paused", agent)); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
  pausedAgents() {
    return readdirSync(path.join(this.root, "agents")).filter(name => name.endsWith(".md"))
      .map(name => name.slice(0, -3)).filter(agent => this.isPaused(agent)).sort();
  }
  receipt(key) { return nativeReceipt(this, key) || readJson(path.join(this.records, `${digest(key)}.json`)); }
  submission(key) {
    const existing = this.receipt(key);
    if (!existing) return null;
    if (existing.nativeMessageId) {
      const task = this.task(existing.taskId);
      if (existing.phase === "published" && !task) throw new Error(`Published Spool task is missing: ${existing.taskId}`);
      return existing.phase === "published" ? { task, at: existing.publishedAt } : null;
    }
    const task = this.task(existing.taskId) || this.withdrawn(existing.taskId), payload = existing.payload;
    const publishedPayload = existing.phase === "pending" && payload && task && task.prompt === payload.prompt &&
      task.created_at === payload.created_at && task.agent === payload.agent &&
      samePath(task.workspace, payload.workspace) &&
      (payload.comments || []).every(comment => (task.comments || []).some(current =>
        (current.message || current.content) === (comment.message || comment.content) && current.author === comment.author));
    if (task && (existing.phase === "published" || publishedPayload)) {
      let published = existing;
      if (existing.phase !== "published") {
        published = { ...existing, phase: "published", publishedAt: task.updated_at,
          payload: undefined, previous: undefined };
        writeJson(path.join(this.records, `${digest(key)}.json`), published);
      }
      const indexed = this.metadata(task.id);
      if (indexed?.key === key && indexed.phase !== "published") {
        writeJson(path.join(this.records, `task-${task.id}.json`), published);
      }
      return { task, at: published.publishedAt || task.updated_at };
    }
    if (existing.phase === "published") throw new Error(`Published Spool task is missing: ${existing.taskId}`);
    return null;
  }
  recoverSubmission(key) {
    const submitted = this.submission(key);
    if (submitted) return submitted;
    const receipt = this.receipt(key);
    if (receipt?.nativeMessageId) return recoverNativeCommand(this, key);
    if (receipt?.phase !== "pending") return null;
    const payload = receipt.payload, previous = receipt.previous;
    if (!payload || payload.id !== receipt.taskId || !previous ||
        !["completed", "failed"].includes(previous.status) ||
        path.dirname(previous.archive || "") !== path.join(this.queues, ".runner-archive") ||
        !path.basename(previous.archive).startsWith(`${safeId(receipt.taskId)}-`)) {
      throw new Error(`Submission ${key} lacks a verified original-task recovery journal`);
    }
    this.assertIdle(payload.agent, payload.workspace, null, receipt.independentWorkspace
      ? { taskId: payload.id, sessionId: payload.session_id } : null);
    if (this.liveTasks([payload]).length) throw new Error(`Original session for ${payload.id} is still alive; recovery held`);
    const task = this.task(payload.id);
    const currentMetadata = this.metadata(payload.id);
    const alreadyRestored = task && !existsSync(previous.archive) &&
      JSON.stringify(currentMetadata) === JSON.stringify(previous.metadata);
    if (currentMetadata?.key !== key && !alreadyRestored) {
      throw new Error(`Submission ${key} is not the current task generation; recovery held`);
    }
    const original = task || readJson(previous.archive);
    if (!original || original.id !== payload.id || original.agent !== payload.agent ||
        original.session_id !== payload.session_id ||
        (!samePath(original.workspace, payload.workspace) && !verifiedWorkspaceMigration(receipt, original.workspace, payload.workspace)) ||
        original.created_at !== payload.created_at) {
      throw new Error(`Submission ${key} does not match its archived original task; recovery held`);
    }
    if (!task) {
      const target = path.join(this.queues, previous.status, `${safeId(payload.id)}.json`);
      renameSync(previous.archive, target);
    }
    // Restore the original terminal item, not a possibly stale prepared revision.
    if (previous.metadata) writeJson(path.join(this.records, `task-${payload.id}.json`), previous.metadata);
    else rmSync(path.join(this.records, `task-${payload.id}.json`), { force: true });
    if (original.acceptance) {
      if (!previous.metadata?.preparation?.branch) throw new Error("Original bundle preparation is missing; recovery held");
      writeJson(path.join(this.records, "bundle-contracts", `${payload.id}.json`), {
        version: 1, taskId: original.id, agent: original.agent, workspace: original.workspace,
        branch: previous.metadata.preparation.branch, acceptance: original.acceptance,
      });
    }
    writeJson(path.join(this.records, `${digest(key)}.json`), {
      ...receipt, phase: "interrupted", interruptedAt: new Date().toISOString(),
      reason: "Queue publication did not finish; original task restored for fresh preparation",
    });
    return null;
  }
  submit(input) { return submit.call(this, input); }
  metadata(id) { return this.task(id)?.runner_metadata || this.withdrawn(id)?.runner_metadata ||
    readJson(path.join(this.records, `task-${safeId(id)}.json`)); }
}
