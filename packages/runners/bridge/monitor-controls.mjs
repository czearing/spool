import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupAgentBranch } from "../packages/bohemia-agent-tooling/src/index.js";
import { canonicalPath, readJson, samePath, writeJson } from "./spool-store.mjs";
import { withAdmission } from "./admission.mjs";
import { renderSpoolTaskPrompt } from "./queue.mjs";
import { publishOnce as publish } from "./spool-files.mjs";

const execute = promisify(execFile);
const identifier = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (message, code = 400) => { throw Object.assign(new Error(message), { code }); };
const required = (value, name, max) => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) fail(`Invalid ${name}`);
  return value;
};
export function createMonitorControls(store, { prepare = setupAgentBranch, refreshProcesses = async () => {}, now = () => Date.now() } = {}) {
  const root = path.join(store.root, "controls");
  const file = (directory, id) => path.join(root, directory, `${id}.json`);
  const folders = ["commands", "requests", "results", "history", "manual", "manual-history", "workspace-holds"];
  for (const directory of folders) mkdirSync(path.join(root, directory), { recursive: true });
  let busy = false;
  function capability() {
    const capability = readJson(path.join(root, "capabilities.json"));
    const age = now() - Date.parse(capability?.updatedAt);
    return capability?.version === 1 && age >= 0 && age < 12000 ? capability : null;
  }
  const enabled = () => capability()?.interactive === true;
  const statusEnabled = () => capability()?.statusControl === true;
  const taskEnabled = () => capability()?.taskControl === true;
  function workspaces() {
    return [...new Set(store.tasks().map(task => task.workspace).filter(workspace =>
      workspace && path.isAbsolute(workspace) && existsSync(path.join(workspace, ".git"))).map(canonicalPath))].sort();
  }
  function receipt(id) {
    if (!identifier.test(id)) fail("Invalid command identity");
    const completed = readJson(file("results", id));
    if (completed) return completed;
    const job = readJson(file("manual", id));
    return job ? { id, taskId: job.request.taskId, status: job.status, detail: job.detail }
      : existsSync(file("commands", id)) ? { id, status: "queued" } : null;
  }
  function stage(input) {
    if (input?.kind === "message" && input.metadata !== undefined && capability()?.preparedMessageVersion !== 1)
      fail("Update Spool to support native prepared messages", 503);
    if (!(input?.kind === "status" ? statusEnabled()
      : ["create", "handoff"].includes(input?.kind) ? taskEnabled() : enabled())) fail("Requested Spool workflow control is not online", 503);
    if (!input || Array.isArray(input) || !identifier.test(input.id)) fail("Invalid command identity");
    const allowed = {
      create: ["id", "kind", "agent", "title", "prompt", "workspace"],
      message: ["id", "kind", "taskId", "message", "metadata"], interrupt: ["id", "kind", "taskId"],
      handoff: ["id", "kind", "taskId", "agent", "message"],
      status: ["id", "kind", "taskId", "status", "expectedStatus"],
    }[input.kind];
    if (!allowed || Object.keys(input).some(key => !allowed.includes(key))) fail("Invalid operator action");
    const previous = readJson(file("commands", input.id));
    if (previous && JSON.stringify(previous.input) !== JSON.stringify(input)) fail("Command identity was reused for different input", 409);
    if (!previous) {
      const request = { id: input.id, kind: input.kind, taskId: input.taskId, createdAt: new Date(now()).toISOString() };
      if (input.agent !== undefined) {
        store.validateAgent(required(input.agent, "agent", 180));
        request.agent = input.agent;
      }
      if (["message", "handoff"].includes(input.kind)) request.message = required(input.message, "message", 65536);
      if (input.kind === "message" && input.metadata !== undefined) request.metadata = input.metadata;
      if (input.kind === "create") {
        if (!request.agent) fail("Agent is required");
        request.taskId = `manual-${input.id}`;
        request.title = required(input.title, "title", 500);
        request.prompt = renderSpoolTaskPrompt(required(input.prompt, "instructions", 120000), request.agent);
        if (input.workspace === "isolated") {
          request.workspace = path.join(store.root, "workspaces", request.taskId);
        } else if (!input.workspace || input.workspace === "bohemia" || input.workspace === "spool") {
          const agentTask = store.tasks().find(t => t.agent === request.agent && t.workspace);
          request.workspace = agentTask ? canonicalPath(agentTask.workspace) : (workspaces()[0] || path.join(store.root, "workspaces", request.taskId));
        } else {
          const requested = required(input.workspace, "workspace", 4096);
          if (!workspaces().some(workspace => samePath(workspace, requested))) fail("Select a registered workspace");
          request.workspace = canonicalPath(requested);
        }
      } else {
        const task = store.task(required(input.taskId, "task identity", 180));
        if (!task) fail("Task not found", 404);
        if (input.kind === "handoff") {
          if (!request.agent) fail("Agent is required");
          if (!["incoming", "in_progress"].includes(task.status)) fail("Reopen this work item before assigning it", 409);
          if (request.agent === task.agent) fail("This agent already owns the work item", 409);
          if (task.interaction?.handoff) fail("Another handoff is already pending", 409);
          if (store.isPaused(request.agent)) fail("Agent is paused by operator", 409);
        }
        if (input.kind === "status") {
          const statuses = ["incoming", "in_progress", "completed", "failed"];
          if (!statuses.includes(input.status) || !statuses.includes(input.expectedStatus)) fail("Unknown Spool task status");
          if (task.status !== input.expectedStatus) fail("Task state changed; refresh before moving it", 409);
          request.status = input.status;
          request.expectedStatus = input.expectedStatus;
          request.agent = task.agent;
          request.workspace = task.workspace;
          if (["incoming", "in_progress"].includes(input.status) && store.isPaused(task.agent)) fail("Agent is paused by operator", 409);
        }
      }
      const saved = publish(file("commands", input.id), { input, request });
      if (JSON.stringify(saved.input) !== JSON.stringify(input)) fail("Command identity collision", 409);
    }
    return readJson(file("commands", input.id)).request;
  }
  function submit(input) {
    const request = stage(input);
    if (!readJson(file("results", input.id))) {
      if (input.kind === "create") {
        publish(file("manual", input.id), { request, isolated: input.workspace === "isolated", status: "waiting", detail: "Waiting for safe workspace admission" });
      } else if (input.kind === "status" && ["incoming", "in_progress"].includes(input.status) &&
          ["completed", "failed"].includes(input.expectedStatus)) {
        publish(file("manual", input.id), { request, status: "waiting", detail: "Waiting to prepare the original task workspace" });
      } else publish(file("requests", input.id), request);
    }
    return { id: input.id, taskId: request.taskId, status: "queued" };
  }
  async function jobs() {
    if (busy || (!taskEnabled() && !statusEnabled())) return;
    busy = true;
    try {
      for (const name of readdirSync(path.join(root, "manual")).filter(name => name.endsWith(".json")).sort()) {
        const jobFile = path.join(root, "manual", name);
        let job = readJson(jobFile);
        if (!job || job.status === "failed") continue;
        const request = job.request, holdFile = file("workspace-holds", request.id);
        if (request.kind === "status" ? !statusEnabled() : !taskEnabled()) continue;
        const result = readJson(file("results", request.id));
        if (result) {
          if (existsSync(holdFile)) unlinkSync(holdFile);
          renameSync(jobFile, file("manual-history", request.id));
          continue;
        }
        if (job.status === "submitted") continue;
        const save = (status, detail, changes = {}) => {
          job = { ...job, ...changes, status, detail, updatedAt: new Date(now()).toISOString() };
          writeJson(jobFile, job);
        };
        try {
          const admission = await withAdmission(store.root, request.agent, async () => {
            await refreshProcesses();
            if (request.kind === "status" && store.task(request.taskId)?.status !== request.expectedStatus) {
              fail("Task state changed before workspace preparation; refresh before moving it", 409);
            }
            try { store.assertIdle(request.agent, request.workspace, request.taskId); }
            catch (error) {
              if (!/owned by Spool task|paused by operator|reserved for/.test(error.message)) throw error;
              save("waiting", error.message);
              return;
            }
            if (!request.workspace || !path.isAbsolute(request.workspace)) fail("Task has no absolute workspace to resume");
            if (job.isolated) mkdirSync(request.workspace, { recursive: true });
            const hold = { taskId: request.taskId, agent: request.agent, workspace: request.workspace, ready: false };
            writeJson(holdFile, hold);
            save("preparing", job.isolated ? "Preparing isolated workspace" : "Running canonical Bohemia preparation");
            let preparation;
            if (!job.isolated && (request.kind !== "status" || existsSync(path.join(request.workspace, ".git")))) {
              const branch = request.kind === "status" ? store.metadata(request.taskId)?.preparation?.branch
                : `user/calebzearing/manual-${request.id}`;
              if (!branch) fail("Original task has no verified prepared branch; cannot safely reopen it");
              const { stdout } = await execute("git", ["-C", request.workspace, "symbolic-ref", "--short", "HEAD"], { windowsHide: true });
              preparation = await prepare({ repoRoot: request.workspace, branch,
                mode: stdout.trim() === branch ? "resume" : request.kind === "status" ? "checkout" : "create",
                reset: false, ...(request.kind === "status" ? { runBuild: false } : {}) });
              if (!preparation?.ready || preparation.branch !== branch || !preparation.commit ||
                  !samePath(preparation.repoRoot, request.workspace)) throw new Error("Canonical preparation was not verified");
              await refreshProcesses();
              store.assertIdle(request.agent, request.workspace, request.taskId);
            }
            if (!existsSync(request.workspace)) fail("Original task workspace is unavailable");
            const metadata = request.kind === "status" ? { ...store.metadata(request.taskId), dashboardPrepared: true,
              ...(preparation ? { preparation } : {}) } : {
              runner: "manual-dashboard", originalPrompt: readJson(file("commands", request.id)).input.prompt,
              ...(preparation ? { preparation } : {}),
            };
            const preparedRequest = { ...request, metadata };
            save("prepared", "Workspace preparation verified", { request: preparedRequest });
            writeJson(holdFile, { ...hold, ready: true });
            publish(file("requests", request.id), preparedRequest);
            save("submitted", "Awaiting native work-item creation");
          }, request.workspace);
          if (admission?.holding) save("waiting", admission.holding);
        } catch (error) {
          console.error(`Manual task preparation failed (${request.taskId}): ${error.stack || error}`);
          save("failed", error.message);
          writeJson(file("results", request.id), { id: request.id, result: { status: "failed", error: error.message } });
          if (existsSync(holdFile)) unlinkSync(holdFile);
        }
      }
    } finally { busy = false; }
  }
  return {
    options: () => ({ enabled: enabled(), taskEnabled: taskEnabled(), statusEnabled: statusEnabled(), workspaces: workspaces() }),
    stage, submit, receipt, jobs,
  };
}
