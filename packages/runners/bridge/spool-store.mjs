import { safeId, digest, samePath, verifiedWorkspaceMigration, readJson, writeJson } from "./spool-files.mjs";
import { existsSync, linkSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { windowsProcesses } from "../packages/bohemia-agent-tooling/src/index.js";
import { submit } from "./spool-submission.mjs";
import { nativeReceipt, recoverNativeCommand } from "./native-continuation.mjs";

// Follow the daemon's move direction so incoming -> in_progress cannot vanish during enumeration.
const states = ["incoming", "in_progress", "completed", "failed"];
const priority = { incoming: 3, in_progress: 4, completed: 2, failed: 1 };
export { safeId, digest, canonicalPath, samePath, verifiedWorkspaceMigration, readJson, writeJson } from "./spool-files.mjs";

function readTask(file, state) {
  const task = readJson(file);
  if (!task) return null;
  if (`${safeId(task.id)}.json` !== path.basename(file) || typeof task.agent !== "string" ||
      typeof task.prompt !== "string") throw new Error(`Invalid Spool task: ${file}`);
  return { ...task, status: state, file };
}

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
  tasks() {
    const tasks = new Map();
    for (const state of states) {
      const folder = path.join(this.queues, state);
      for (const name of readdirSync(folder)) {
        if (!name.endsWith(".json")) continue;
        const task = readTask(path.join(folder, name), state);
        if (!task) continue; // The daemon can move a file between enumeration and read.
        if (!tasks.has(task.id) || priority[state] > priority[tasks.get(task.id).status]) {
          tasks.set(task.id, task);
        }
      }
    }
    return [...tasks.values()];
  }
  task(id) {
    safeId(id);
    let task = null;
    for (const state of states) {
      const candidate = readTask(path.join(this.queues, state, `${id}.json`), state);
      if (candidate && (!task || priority[state] > priority[task.status])) task = candidate;
    }
    return task;
  }
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
  assertIdle(agent, workspace, exceptId = null, independent = null) {
    if (agent !== null) this.validateAgent(agent);
    if (agent !== null && this.isPaused(agent)) throw new Error(`Spool agent ${agent} is paused by operator`);
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
            samePath(hold.workspace, workspace))) {
          throw new Error(`Workspace/agent is reserved for ${hold.taskId}; preparation held`);
        }
      }
    }
    const tasks = this.tasks(), live = new Set(this.liveTasks(tasks).map(task => task.id));
    const owner = tasks.find(task => ((independent
      ? task.id === independent.taskId || task.session_id === independent.sessionId
      : task.agent === agent) || samePath(task.workspace, workspace)) &&
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
