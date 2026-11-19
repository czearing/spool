import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalPath, queuedOperatorChat, readJson, samePath, verifiedWorkspaceMigration, writeJson } from "./spool-store.mjs";
import { withAdmission } from "./admission.mjs";
import { renderSpoolTaskPrompt } from "./queue.mjs";
import { operatorConversation, queuedOperatorMessage, publishOnce as publish } from "./spool-files.mjs";
import { messageByteLimit } from "./message-payload.mjs";
import { recoveryCommandId } from "./control-identity.mjs";
import { CodespaceRequests, codespaceConnectionFailure } from "../packages/repository-mcp/src/codespaces/github-requests.mjs";
import { createWorkspaceReadiness, hasReviewRequest, workspaceRequirement } from "./workspace-readiness.mjs";

const execute = promisify(execFile);
const identifier = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (message, code = 400) => { throw Object.assign(new Error(message), { code }); };
const required = (value, name, max) => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) fail(`Invalid ${name}`);
  return value;
};
export function pendingMessages(spoolRoot, task) {
  const root = path.join(spoolRoot, "controls"), directory = path.join(root, "native-resumes");
  let names;
  try { names = readdirSync(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const applied = new Set([...(task.interaction?.applied_requests || []),
    ...(task.interaction?.messages || []).map(message => message.id)]);
  return names.filter(name => name.endsWith(".json")).flatMap(name => {
    const job = readJson(path.join(directory, name)), request = job?.request;
    if (request?.kind !== "message" || request.metadata || request.taskId !== task.id || applied.has(request.id)) return [];
    const result = readJson(path.join(root, "results", `${request.id}.json`))?.result;
    const error = result?.status === "failed" ? result.error || "Spool could not queue this message."
      : job.status === "failed" ? job.detail : undefined;
    return [{ id: request.id, text: request.message, created_at: request.createdAt,
      status: error ? "failed" : "queued", ...(error ? { error } : {}) }];
  }).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}
export function createMonitorControls(store, { prepare = async input =>
  (await import("../packages/bohemia-agent-tooling/src/branch-setup.js")).setupAgentBranch(input),
  refreshProcesses = async () => {},
  verifyNativePreparation = async prepared => {
    const { verifySavedCodespace } = await import("../packages/repository-mcp/src/codespaces/review.mjs");
    await verifySavedCodespace(prepared);
  }, verifyEngineeringPreparation = async prepared => {
    const { verifyEngineeringCodespace } = await import("../packages/repository-mcp/src/codespaces/engineering.mjs");
    await verifyEngineeringCodespace(prepared);
  }, readiness, now = () => Date.now() } = {}) {
  const root = path.join(store.root, "controls");
  const file = (directory, id) => path.join(root, directory, `${id}.json`);
  function appliedMessageReceipt(request) {
    if (request.kind !== "message" || request.metadata) return null;
    const task = store.task(request.taskId);
    if (!task?.interaction?.applied_requests?.includes(request.id) ||
        !task.interaction.messages?.some(message => message.id === request.id && message.text === request.message))
      return null;
    const previous = readJson(file("results", request.id));
    if (previous?.result?.status === "accepted") return previous;
    const receipt = { id: request.id, result: { status: "accepted", taskId: request.taskId, action: "message" } };
    writeJson(file("results", request.id), receipt);
    return receipt;
  }
  const folders = ["commands", "requests", "results", "history", "manual", "native-resumes", "manual-history", "workspace-holds"];
  for (const directory of folders) mkdirSync(path.join(root, directory), { recursive: true });
  let scanning = false;
  const runningAgents = new Set();
  function capability() {
    const capability = readJson(path.join(root, "capabilities.json"));
    const age = now() - Date.parse(capability?.updatedAt);
    return capability?.version === 1 && age >= 0 && age < 12000 ? capability : null;
  }
  const enabled = () => capability()?.interactive === true;
  const statusEnabled = () => capability()?.statusControl === true;
  const taskEnabled = () => capability()?.taskControl === true;
  const nativeProvider = agent => readJson(path.join(store.root, "spool.json"))?.copilotProviders?.[agent];
  function queuedOperatorInput(task) {
    return queuedOperatorChat(task) || queuedOperatorMessage(store.root, task);
  }
  const workspaceReadiness = readiness || createWorkspaceReadiness(store, {
    verify: prepared => prepared.execution?.kind === "codespace"
      ? prepared.execution.purpose === "engineering" ? verifyEngineeringPreparation(prepared)
        : verifyNativePreparation(prepared)
      : import("./workflow-workspace.mjs").then(({ verifyEventWorkspace }) => verifyEventWorkspace(prepared)),
  });
  function requirement(agent, workspace) {
    const native = nativeProvider(agent), args = native?.args || [], index = args.indexOf("--config");
    const configFile = index >= 0 ? args[index + 1] : native
      ? readJson(path.join(workspace, "preparation.json"))?.execution?.configFile : undefined;
    return workspaceRequirement(store, agent, configFile ? readJson(configFile) : null, configFile);
  }
  function workspaces() {
    return [...new Set(store.tasks().map(task => task.workspace).filter(workspace =>
      workspace && path.isAbsolute(workspace) && existsSync(path.join(workspace, ".git"))).map(canonicalPath))].sort();
  }
  function receipt(id) {
    if (!identifier.test(id)) fail("Invalid command identity");
    const completed = readJson(file("results", id));
    if (completed) return completed;
    const job = readJson(file("manual", id)) || readJson(file("native-resumes", id));
    return job ? { id, taskId: job.request.taskId, status: job.status, detail: job.detail }
      : existsSync(file("commands", id)) ? { id, status: "queued" } : null;
  }
  function stage(input, { verbatim = false } = {}) {
    const deferredMessage = input?.kind === "message" && input.metadata === undefined && !capability();
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
    if (input.kind === "message" && input.metadata !== undefined && capability()?.preparedMessageVersion !== 1)
      fail("Update Spool to support native prepared messages", 503);
    if (!(previous && input.kind === "message" && input.metadata === undefined) &&
        !(input.kind === "status" ? statusEnabled()
          : ["create", "handoff"].includes(input.kind) ? taskEnabled() : enabled()) && !deferredMessage)
      fail("Requested Spool workflow control is not online", 503);
    if (!previous) {
      const request = { id: input.id, kind: input.kind, taskId: input.taskId, createdAt: new Date(now()).toISOString() };
      let conversation;
      if (input.agent !== undefined) {
        store.validateAgent(required(input.agent, "agent", 180));
        request.agent = input.agent;
      }
      if (["message", "handoff"].includes(input.kind)) request.message = required(input.message, "message", messageByteLimit);
      if (input.kind === "message" && input.metadata !== undefined) request.metadata = input.metadata;
      if (input.kind === "create") {
        if (!request.agent) fail("Agent is required");
        request.taskId = `manual-${input.id}`;
        request.title = required(input.title, "title", 500);
        const prompt = required(input.prompt, "instructions", 120000);
        request.prompt = verbatim ? prompt : renderSpoolTaskPrompt(prompt, request.agent);
        if (input.workspace === "isolated") {
          if (nativeProvider(request.agent)) fail("Native agents use their assigned Codespace; local isolation is not supported");
          request.workspace = path.join(store.root, "workspaces", request.taskId);
        } else if (!input.workspace || input.workspace === "bohemia" || input.workspace === "spool") {
          const agentTask = store.tasks().find(t => t.agent === request.agent && t.workspace);
          request.workspace = agentTask ? canonicalPath(agentTask.workspace) : nativeProvider(request.agent)
            ? store.root : (workspaces()[0] || path.join(store.root, "workspaces", request.taskId));
          let configured = requirement(request.agent, request.workspace);
          if (configured?.reviewConfig && !hasReviewRequest(null, request)) configured = null;
          if (configured) request.workspace = canonicalPath(configured.input.repoRoot);
        } else {
          const requested = required(input.workspace, "workspace", 4096);
          if (!workspaces().some(workspace => samePath(workspace, requested))) fail("Select a registered workspace");
          request.workspace = canonicalPath(requested);
        }
      } else {
        const task = store.task(required(input.taskId, "task identity", 180));
        if (!task) fail("Task not found", 404);
        if (input.kind === "message" && input.metadata === undefined) {
          request.agent = task.agent;
          request.workspace = task.workspace ?? store.root;
          conversation = { sessionId: task.session_id, status: task.status };
        }
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
          request.workspace = task.workspace ?? (nativeProvider(task.agent) ? store.root : task.workspace);
          if (["incoming", "in_progress"].includes(input.status) && store.isPaused(task.agent) && !queuedOperatorInput(task)) fail("Agent is paused by operator", 409);
        }
      }
      const saved = publish(file("commands", input.id), { input, request, ...(conversation ? { conversation } : {}) });
      if (JSON.stringify(saved.input) !== JSON.stringify(input)) fail("Command identity collision", 409);
    }
    const request = readJson(file("commands", input.id)).request;
    if (["create", "message"].includes(input.kind) ||
        input.kind === "status" && ["incoming", "in_progress"].includes(input.status)) {
      const task = input.taskId ? store.task(input.taskId) : null;
      store.ensureControlWorkspace(request.agent ?? task?.agent, request.workspace ?? task?.workspace ?? store.root,
        task?.session_id ? task.session_config?.provider ?? null : undefined);
    }
    return request;
  }
  function assertMessageOwner(job, current) {
    const request = job.request;
    if (current?.agent !== request.agent ||
        !store.ownsWorkspace({ ...current, workspace: current?.workspace ?? store.root }, request.agent, request.workspace ?? store.root) ||
        current.session_id !== job.sessionId &&
          (job.sessionId || !["incoming", "in_progress"].includes(job.expectedStatus)))
      fail("Original conversation ownership changed while its message waited", 409);
  }
  const messageOrder = (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);
  const continuationReady = (job, task) => !job.queuedOffline ||
    ["incoming", "in_progress"].includes(task?.status) || capability()?.messageContinuationVersion === 1;
  function earlierMessage(job) {
    return readdirSync(path.join(root, "native-resumes")).filter(name => name.endsWith(".json")).some(name => {
      const earlier = readJson(path.join(root, "native-resumes", name)), request = earlier?.request;
      return request?.kind === "message" && !request.metadata && request.taskId === job.request.taskId &&
        earlier.status !== "failed" && messageOrder(request, job.request) < 0 && !readJson(file("results", request.id));
    });
  }
  function submit(input) {
    const request = stage(input);
    const task = input.kind === "message" ? store.task(request.taskId) : null;
    if (!readJson(file("results", input.id))) {
      if (input.kind === "create") {
        publish(file("manual", input.id), { request, isolated: input.workspace === "isolated", status: "waiting", detail: "Waiting for safe workspace admission" });
      } else if (input.kind === "status" && ["incoming", "in_progress"].includes(input.status) &&
          ["completed", "failed"].includes(input.expectedStatus)) {
        publish(file("manual", input.id), { request, status: "waiting", detail: "Waiting to prepare the original task workspace" });
      } else if (input.kind === "message" && (input.metadata === undefined || nativeProvider(task?.agent) &&
          ["completed", "failed"].includes(task?.status) &&
          !(task.provider && store.liveTasks([task]).length))) {
        const jobFile = file("native-resumes", input.id);
        const conversation = readJson(file("commands", input.id)).conversation ??
          { sessionId: task.session_id, status: task.status };
        const job = publish(jobFile, { request: { ...request, agent: request.agent ?? task.agent, workspace: request.workspace ?? task.workspace ?? store.root },
          expectedStatus: conversation.status, sessionId: conversation.sessionId,
          queuedOffline: !enabled(), status: "waiting", detail: "Waiting for safe original-session admission" });
        if (input.metadata === undefined && enabled() && continuationReady(job, task) && !earlierMessage(job) && (!nativeProvider(task.agent) ||
            ["incoming", "in_progress"].includes(task.status) || task.provider && store.liveTasks([task]).length)) {
          assertMessageOwner(job, task);
          publish(file("requests", input.id), job.request);
          writeJson(jobFile, { ...job, status: "submitted", detail: "Awaiting Spool acceptance" });
        }
      } else publish(file("requests", input.id), request);
    }
    return { id: input.id, taskId: request.taskId, status: "queued" };
  }
  async function submitPreparedMessage(input) {
    const request = stage(input), metadata = input.metadata, task = store.task(request.taskId);
    const runner = metadata?.metadata?.runner, preparation = metadata?.metadata?.preparation;
    if (input.kind !== "message" || !["pr-reviewer", "pr-updater"].includes(runner) ||
        !nativeProvider(task?.agent) || metadata.agent !== task.agent ||
        metadata.sessionId !== task.session_id || metadata.expectedUpdatedAt !== task.updated_at ||
        !samePath(metadata.workspace, task.workspace) &&
          !verifiedWorkspaceMigration(metadata.metadata, task.workspace, metadata.workspace))
      fail("Prepared message must preserve its native task, agent, session and workspace", 409);
    store.assertIdle(task.agent, metadata.workspace, task.id);
    if (runner === "pr-reviewer") await verifyNativePreparation(preparation);
    else {
      if (preparation?.execution?.kind !== "codespace" || preparation.execution.purpose !== "engineering" ||
          !samePath(preparation.repoRoot, metadata.workspace))
        fail("Prepared update requires its verified engineering Codespace", 409);
      await verifyEngineeringPreparation(preparation);
    }
    if (!readJson(file("results", input.id))) publish(file("requests", input.id), request);
    return { id: input.id, taskId: request.taskId, status: "queued" };
  }
  async function submitPreparedReviewerRestart(input, preparation) {
    const request = stage(input), task = store.task(request.taskId);
    const original = store.metadata(task?.id)?.preparation;
    if (input.kind !== "status" || input.expectedStatus !== "failed" ||
        !["incoming", "in_progress"].includes(input.status) || !nativeProvider(task?.agent) ||
        task?.provider || store.liveTasks([task]).length ||
        task?.interaction?.messages?.some(message => ["delivering", "delivery_uncertain"].includes(message.status)) ||
        store.metadata(task?.id)?.runner !== "pr-reviewer" ||
        !preparation?.ready || preparation.execution?.kind !== "codespace" ||
        !samePath(preparation.repoRoot, task?.workspace) ||
        !samePath(preparation.repoRoot, original?.repoRoot) ||
        preparation.commit !== original?.commit || preparation.branch !== original?.branch ||
        Number(preparation.pr?.id ?? preparation.prId) !== Number(original?.pr?.id ?? original?.prId))
      fail("Prepared reviewer restart must preserve its original task, workspace and exact PR revision", 409);
    const previous = readJson(file("results", request.id));
    if (previous?.result?.status === "accepted") return previous;
    if (previous) fail(previous.result?.error || "Prepared reviewer restart was rejected", 409);
    store.assertIdle(task.agent, task.workspace, task.id);
    await verifyNativePreparation(preparation);
    const current = store.task(task.id);
    if (current?.status !== task.status || current?.updated_at !== task.updated_at ||
        current?.provider || store.liveTasks([current]).length ||
        current?.session_id !== task.session_id)
      fail("Original reviewer changed while its preparation was verified", 409);
    store.assertIdle(task.agent, task.workspace, task.id);
    const preparedRequest = { ...request, metadata: { ...store.metadata(task.id),
      dashboardPrepared: true, preparation } };
    publish(file("manual", request.id), { request: preparedRequest, status: "submitted",
      detail: "Verified runner preparation; awaiting original reviewer restart" });
    writeJson(file("workspace-holds", request.id), {
      taskId: task.id, agent: task.agent, workspace: task.workspace, ready: true,
    });
    publish(file("requests", request.id), preparedRequest);
    return { id: input.id, taskId: task.id, status: "queued" };
  }
  async function jobs() {
    if (scanning || (!taskEnabled() && !statusEnabled() && !enabled())) return;
    scanning = true;
    let admissions;
    try {
      await workspaceReadiness.releaseIdle();
      for (const task of store.tasks()) {
        const workspace = task.workspace ?? store.root;
        const messages = task.interaction?.messages || [];
        const message = messages.findLast(message => message.status === "queued");
        const operatorInput = queuedOperatorInput(task);
        const chatStartup = !task.session_id && task.turns === 0 && operatorConversation(store.root, task) &&
          /^Copilot ACP startup failed:/.test(task.error || "") &&
          (codespaceConnectionFailure(task.error) || /Codespace preparation is not ready/.test(task.error));
        const interruptedStartup = (message || chatStartup) && /^Copilot ACP startup failed:/.test(task.error || "") &&
          (codespaceConnectionFailure(task.error) || chatStartup);
        const emptyRestore = enabled() && !task.acceptance &&
          task.error === "Restored session has no pending message; original assignment will not be replayed" &&
          messages.every(message => message.status === "delivered");
        if (task.status !== "failed" || task.provider || !task.session_id && !interruptedStartup || !nativeProvider(task.agent) ||
            !path.isAbsolute(workspace) || !existsSync(workspace) ||
            !["ended", "waiting_preparation"].includes(task.interaction?.phase) ||
            task.interaction.paused || store.isPaused(task.agent) && !operatorInput ||
            messages.some(message => ["delivering", "delivery_uncertain"].includes(message.status)) ||
            store.metadata(task.id)?.runner === "pr-reviewer" && !operatorInput ||
            !message && !emptyRestore && !chatStartup ||
            interruptedStartup && now() < Date.parse(task.updated_at) + 15_000) continue;
        const id = recoveryCommandId(task, message, !!interruptedStartup);
        if (readJson(file("results", id)) || readJson(file("manual", id))?.status === "failed") continue;
        submit({ id, kind: "status", taskId: task.id, status: "in_progress", expectedStatus: "failed" });
        publish(file("workspace-holds", id), {
          taskId: task.id, agent: task.agent, workspace, ready: false,
        });
      }
      const jobFiles = ["manual", "native-resumes"].flatMap(directory =>
        readdirSync(path.join(root, directory)).filter(name => name.endsWith(".json")).sort()
          .map(name => path.join(root, directory, name)));
      const agents = new Map();
      for (const jobFile of jobFiles) {
        const agent = readJson(jobFile)?.request?.agent;
        if (!agents.has(agent)) agents.set(agent, []);
        agents.get(agent).push(jobFile);
      }
      async function processJob(jobFile) {
        let job = readJson(jobFile);
        if (!job) return;
        const request = job.request.kind === "message" && job.request.workspace == null
          ? { ...job.request, workspace: store.root } : job.request;
        const holdFile = file("workspace-holds", request.id);
        if (request.kind === "status" ? !statusEnabled() : request.kind === "message" ? !enabled() : !taskEnabled()) return;
        const result = appliedMessageReceipt(request) || readJson(file("results", request.id));
        if (result) {
          if (existsSync(holdFile)) unlinkSync(holdFile);
          if (request.kind === "message" && result.result?.status === "failed")
            writeJson(jobFile, { ...job, status: "failed", detail: result.result.error });
          else renameSync(jobFile, file("manual-history", request.id));
          return;
        }
        if (job.status === "failed") return;
        if (job.status === "submitted" && (request.kind !== "message" || existsSync(file("requests", request.id)))) return;
        if (Date.parse(job.retryAt) > now()) return;
        const save = (status, detail, changes = {}) => {
          const next = { ...job, ...changes, status, detail };
          if (JSON.stringify(next) === JSON.stringify(job)) return;
          job = { ...next, updatedAt: new Date(now()).toISOString() };
          writeJson(jobFile, job);
        };
        if (request.kind === "message" && !request.metadata && earlierMessage(job)) {
          save("waiting", "Waiting for earlier conversation input to enter Spool");
          return;
        }
        try {
          const admission = await withAdmission(store.root, request.agent, async () => {
            await refreshProcesses();
            job = readJson(jobFile);
            if (!job || appliedMessageReceipt(request) || readJson(file("results", request.id)) || job.status === "failed")
              return;
            const current = store.task(request.taskId);
            const operatorChat = request.kind === "message" && !request.metadata ||
              request.kind === "status" && queuedOperatorInput(current);
            const runner = request.metadata?.metadata?.runner;
            const expected = runner === "pr-reviewer" ||
              runner === "pr-updater" && request.metadata?.metadata?.preparation?.execution?.kind === "codespace"
              ? request.metadata.metadata.preparation : null;
            if (expected) {
              const saved = readJson(path.join(request.metadata.workspace || request.workspace, "preparation.json"));
              if (saved?.prId !== expected.prId || saved?.commit !== expected.commit ||
                  saved?.leaseToken !== expected.leaseToken || saved?.branch !== expected.branch)
                fail("Prepared review changed before continuation; repeat its canonical preparation", 409);
              if (runner === "pr-updater" && expected.execution?.kind === "codespace")
                await verifyEngineeringPreparation(expected);
            }
            if (request.kind === "message") assertMessageOwner({ ...job, request }, current);
            if (request.kind === "message" && !continuationReady(job, current)) {
              save("waiting", "Waiting for Spool conversation continuation support");
              return;
            }
            if (request.kind === "message" && !request.metadata &&
                (!nativeProvider(current?.agent) || ["incoming", "in_progress"].includes(current?.status) ||
                  current?.provider && store.liveTasks([current]).length)) {
              publish(file("requests", request.id), request);
              save("submitted", "Delivering queued operator input to the now-active original task");
              return;
            }
            if ((request.kind === "status" || request.kind === "message") &&
                current?.status !== (job.expectedStatus ?? request.expectedStatus)) {
              fail("Task state changed before workspace preparation; refresh before moving it", 409);
            }
            try { store.assertIdle(request.agent, request.workspace, request.taskId, null, { allowPaused: operatorChat }); }
            catch (error) {
              if (!/owned by Spool task|paused by operator|reserved for/.test(error.message)) throw error;
              save("waiting", error.message);
              if (readJson(holdFile)?.ready === false) unlinkSync(holdFile);
              return;
            }
            if (!request.workspace || !path.isAbsolute(request.workspace)) fail("Task has no absolute workspace to resume");
            const native = nativeProvider(request.agent);
            const continuing = native && !!current?.session_id && operatorChat;
            let nativeProfile, nativePreparation;
            if (native) {
              nativePreparation = readJson(path.join(request.workspace, "preparation.json"));
              const args = native.args || [], index = args.indexOf("--config");
              const configFile = index >= 0 ? args[index + 1] : nativePreparation?.execution?.configFile;
              nativeProfile = configFile ? readJson(configFile) : null;
              if (nativeProfile?.githubAccount && nativeProfile.codespace) {
                try { new CodespaceRequests(nativeProfile.githubAccount).check(nativeProfile.codespace); }
                catch (error) {
                  if (!["GITHUB_RATE_LIMITED", "CODESPACE_UNAVAILABLE"].includes(error.code)) throw error;
                  save("waiting", error.message);
                  return;
                }
              }
              // Native source stays remote; only recreate its registered host control storage.
              if (["engineering", "review"].includes(nativeProfile?.purpose) &&
                  samePath(nativeProfile.workspace, request.workspace) &&
                  native.workingDirectory === nativeProfile.remoteRoot)
                mkdirSync(request.workspace, { recursive: true });
              const task = store.task(request.taskId);
              const workspace = store.workspaceIdentity(request.agent, request.workspace, task?.session_config?.provider);
              const operation = readJson(path.join(workspace, "repository-mcp.lock"));
              const application = readJson(path.join(workspace, "application.json"));
              for (const [pid, label] of [[operation?.pid, "repository MCP operation"],
                [application?.ready ? application.ownerPid : null, "application lifecycle"]]) {
                if (!Number.isSafeInteger(pid) || pid <= 0) continue;
                let alive = true;
                try { process.kill(pid, 0); }
                catch (error) { if (error.code !== "ESRCH") throw error; alive = false; }
                if (alive) {
                  save("waiting", `Waiting for ${label} ${pid} to release the original workspace`);
                  return;
                }
              }
            }
            if (job.isolated) mkdirSync(request.workspace, { recursive: true });
            const hold = { taskId: request.taskId, agent: request.agent, workspace: request.workspace, ready: false };
            writeJson(holdFile, hold);
            save("preparing", native ? "Admitting assigned native provider workspace"
              : job.isolated ? "Preparing isolated workspace" : "Running canonical Bohemia preparation");
            let preparation;
            let configured = continuing ? null : requirement(request.agent, request.workspace);
            if (configured?.reviewConfig && (request.kind === "create" || operatorConversation(store.root, current)) &&
                !hasReviewRequest(current, request)) configured = null;
            if (job.requiresPreparation && !configured)
              throw new Error("Workspace preparation configuration changed; retry preparation before launching");
            if (configured) {
              const original = current && (store.metadata(current.id)?.preparation ??
                current.runner_metadata?.preparation);
              const ready = await workspaceReadiness.ensure(configured, {
                request, task: current, expected: expected || original,
                progress: detail => save("preparing", detail),
              });
              if (ready.waiting) {
                save("waiting", ready.waiting);
                unlinkSync(holdFile);
                return;
              }
              preparation = ready.preparation;
            } else if (native) {
              if (nativeProfile?.purpose === "review" && request.kind !== "create" && !continuing &&
                  !operatorConversation(store.root, current)) {
                if (!nativePreparation?.ready) {
                  save("waiting", "Waiting for runner-owned reviewer preparation");
                  unlinkSync(holdFile);
                  return;
                }
                await verifyNativePreparation(nativePreparation);
                preparation = nativePreparation;
              }
            }
            if (!configured && !native && !job.isolated && (request.kind !== "status" || existsSync(path.join(request.workspace, ".git")))) {
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
              store.assertIdle(request.agent, request.workspace, request.taskId, null, { allowPaused: operatorChat });
            }
            if (configured) {
              await refreshProcesses();
              store.assertIdle(request.agent, request.workspace, request.taskId, null, { allowPaused: operatorChat });
            }
            if (!existsSync(request.workspace)) fail("Original task workspace is unavailable");
            const metadata = request.kind === "message"
              ? preparation && request.metadata ? { ...request.metadata,
                metadata: { ...request.metadata.metadata, preparation } } : request.metadata
              : request.kind === "status" ? {
              ...store.metadata(request.taskId), ...request.metadata, dashboardPrepared: true,
              ...(preparation ? { preparation } : {}) } : {
              runner: "manual-dashboard", originalPrompt: readJson(file("commands", request.id)).input.prompt,
              ...(preparation ? { preparation } : {}),
            };
            const preparedRequest = { ...request, ...(metadata === undefined ? {} : { metadata }) };
            save("prepared", native && !preparation ? "Native workspace admitted; repository preparation belongs to the agent"
              : "Workspace preparation verified", { request: preparedRequest });
            const submissionFile = path.join(root, "ui-submissions", `${request.id}.json`);
            const submission = readJson(submissionFile);
            if (job.requiresPreparation) {
              const task = submission?.task;
              if (submission?.phase !== "preparing" || task?.id !== request.taskId ||
                  task.agent !== request.agent || task.prompt !== request.prompt ||
                  task.title !== request.title || !preparation?.ready)
                throw new Error("Prepared task submission no longer matches its original assignment");
              const published = publish(path.join(store.queues, "incoming", `${task.id}.json`), {
                ...task, workspace: request.workspace, runner_metadata: metadata,
              });
              if (published?.id !== task.id || published.prompt !== task.prompt ||
                  JSON.stringify(published.runner_metadata) !== JSON.stringify(metadata))
                throw new Error("Prepared task publication conflicts with an existing work item");
              writeJson(holdFile, { ...hold, ready: true });
              writeJson(submissionFile, { taskId: task.id, fingerprint: submission.fingerprint, phase: "published" });
              writeJson(file("results", request.id), { id: request.id, result: { status: "accepted", taskId: task.id } });
            } else {
              writeJson(holdFile, { ...hold, ready: true });
              publish(file("requests", request.id), preparedRequest);
            }
            save("submitted", "Awaiting native work-item creation");
          }, request.workspace);
          if (admission?.holding) save("waiting", admission.holding);
        } catch (error) {
          if (appliedMessageReceipt(request) || readJson(file("results", request.id))) return;
          if (codespaceConnectionFailure(error)) {
            const attempts = (job.attempts || 0) + 1;
            const retryAt = new Date(Math.max(Date.parse(error.retryAt) || 0,
              now() + Math.min(15_000 * 2 ** Math.min(attempts - 1, 6), 900_000))).toISOString();
            save("waiting", "Reconnecting to Codespace; your message is still queued.",
              { attempts, retryAt, connectionError: error.message });
            if (existsSync(holdFile)) unlinkSync(holdFile);
            return;
          }
          console.error(`Manual task preparation failed (${request.taskId}): ${error.stack || error}`);
          save("failed", error.message);
          publish(file("results", request.id), { id: request.id, result: { status: "failed", error: error.message } });
          if (existsSync(holdFile)) unlinkSync(holdFile);
        }
      }
      admissions = [...agents].map(async ([agent, files]) => {
        if (runningAgents.has(agent)) return;
        runningAgents.add(agent);
        try { for (const jobFile of files) await processJob(jobFile); }
        finally { runningAgents.delete(agent); }
      });
    } finally { scanning = false; }
    const results = await Promise.allSettled(admissions);
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  return {
    options: () => ({ enabled: enabled(), taskEnabled: taskEnabled(), statusEnabled: statusEnabled(), workspaces: workspaces() }),
    stage, submit, submitPreparedMessage, submitPreparedReviewerRestart, receipt,
    pendingMessages: task => pendingMessages(store.root, task),
    jobs, stop: () => workspaceReadiness.dispose(),
  };
}
