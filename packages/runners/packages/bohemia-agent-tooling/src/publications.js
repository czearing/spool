import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { acquireProcessLock } from "./process-lock.js";
import { writeRunnerJson } from "./runner-files.js";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const revision = /^[0-9a-f]{40}$/i;
const read = file => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
const samePath = (a, b) => {
  const normalize = value => {
    const resolved = realpathSync.native(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
};

export function publicationDirectory(environment = process.env) {
  const directory = environment.REPOSITORY_MCP_PUBLICATIONS || path.join(homedir(), ".repository-mcp", "publications");
  if (!path.isAbsolute(directory)) throw new Error("Publication registry must be an absolute path");
  return directory;
}

export function publicationUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Publication requires a canonical HTTPS PR URL");
  return url.href.toLowerCase()
    .replace(/^https:\/\/([^.]+)\.visualstudio\.com\//, "https://dev.azure.com/$1/")
    .replace(/\/+$/, "");
}

export function publicationFile(url, directory = publicationDirectory()) {
  return path.join(directory, `${createHash("sha256").update(publicationUrl(url)).digest("hex")}.json`);
}

export function readPublication(url, directory) {
  return read(publicationFile(url, directory));
}

export function readPublications(directory = publicationDirectory()) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(name => read(path.join(directory, name)));
}

// Old descriptors remain readable while already-running providers finish.
export function executionContext(environment = process.env, { allowTerminal = false } = {}) {
  const file = environment.SPOOL_EXECUTION_CONTEXT || environment.BOHEMIA_CREATOR_CONTEXT;
  const directory = publicationDirectory(environment);
  if (!file) {
    if (!environment.COPILOT_SESSION_ID) return null;
    if (!uuid.test(environment.COPILOT_SESSION_ID)) throw new Error("Invalid publishing conversation ID");
    return { version: 1, originKind: "copilot", sessionId: environment.COPILOT_SESSION_ID,
      taskId: null, agent: environment.CAIRN_HARNESS_AGENT || null,
      workspace: null, projectRoot: null, receiptDirectory: directory };
  }
  if (!path.isAbsolute(file)) throw new Error("Execution context must be an absolute path");
  const context = read(file);
  const root = context?.projectRoot || context?.nativeRoot ||
    (context?.receiptDirectory && path.resolve(context.receiptDirectory, "..", ".."));
  if (!context || ![1, 2].includes(context.version) || !identifier.test(context.taskId || "") ||
      !identifier.test(context.agent || "") || !path.isAbsolute(root || "") ||
      context.workspace != null && (typeof context.workspace !== "string" ||
        !path.isAbsolute(context.workspace) || !existsSync(context.workspace)) ||
      ![path.join(root, "controls", "executions", `${context.taskId}.json`),
        path.join(root, ".runner-receipts", "creator-contexts", `${context.taskId}.json`)]
        .some(expected => existsSync(expected) && samePath(file, expected)))
    throw new Error("Invalid publishing execution context");
  const deferred = context.deferred === true && context.sessionId === null;
  const task = read(path.join(root, "queues", deferred ? "completed" : "in_progress", `${context.taskId}.json`)) ||
    (allowTerminal && (read(path.join(root, "queues", "completed", `${context.taskId}.json`)) ||
      read(path.join(root, "queues", "failed", `${context.taskId}.json`))));
  if (!task || task.id !== context.taskId || task.agent !== context.agent ||
      (task.workspace == null ? context.workspace != null : !context.workspace || !samePath(task.workspace, context.workspace)))
    throw new Error("Publishing execution context no longer matches its task");
  if (deferred) {
    if (!(task.deferred_session || task.deferred_pr_owner) || task.session_id != null ||
        task.session_config != null || task.provider != null || task.turns !== 0 || task.status !== "completed")
      throw new Error("Deferred publication requires an unused reserved task");
  } else {
    const providerBound = typeof context.providerToken === "string" &&
      context.providerToken.startsWith("spool-provider-") &&
      uuid.test(context.providerToken.slice("spool-provider-".length)) &&
      task.provider?.token === context.providerToken && environment.SPOOL_PROVIDER_TOKEN === context.providerToken;
    if (!uuid.test(context.sessionId || "") || task.session_id !== context.sessionId ||
        (task.provider ? !providerBound : context.providerToken != null || environment.COPILOT_SESSION_ID !== context.sessionId) ||
        environment.COPILOT_SESSION_ID && environment.COPILOT_SESSION_ID !== context.sessionId)
      throw new Error("Publishing conversation or provider lease does not match the active execution context");
  }
  return { version: 1, originKind: deferred ? "spool_automation" : "spool",
    taskId: task.id, agent: task.agent, sessionId: context.sessionId, workspace: task.workspace,
    taskWorkspace: task.workspace, projectRoot: root, providerToken: context.providerToken,
    originalPrompt: task.prompt, acceptance: task.acceptance, deferred,
    receiptDirectory: directory };
}

export function publicationContext(environment = process.env) {
  return executionContext(environment);
}

export async function recordPublication({ context = publicationContext(), result, branch, repoRoot,
  publication }, { write = writeRunnerJson, onlyIfAbsent = false } = {}) {
  if (!context) return null;
  if ((!uuid.test(context.sessionId || "") && !(context.deferred && context.sessionId === null)) ||
      !result?.ready || !Number.isSafeInteger(result.pullRequestId) || result.pullRequestId <= 0 ||
      !revision.test(result.commit || "") || !revision.test(result.targetCommit || "") ||
      typeof branch !== "string" || !branch || !path.isAbsolute(repoRoot || ""))
    throw new Error("Publication tracking requires the verified PR, checked revision and publishing conversation");
  const url = publicationUrl(result.url);
  if (!url.endsWith(`/pullrequest/${result.pullRequestId}`) && !url.endsWith(`/pull/${result.pullRequestId}`))
    throw new Error("Publication URL does not identify its verified PR");
  const directory = context.receiptDirectory, file = publicationFile(url, directory);
  mkdirSync(directory, { recursive: true });
  const release = await acquireProcessLock(file, { namespace: "repository-publication", timeoutMs: 30_000 });
  try {
    const previous = read(file);
    if (previous && (!previous.verified || publicationUrl(previous.prUrl) !== url || previous.prId !== String(result.pullRequestId) ||
        previous.branch !== branch.replace(/^refs\/heads\//, "")))
      throw new Error("Verified publication changed repository, PR or source branch");
    if (previous && onlyIfAbsent) return previous;
    const now = new Date().toISOString();
    const last = previous?.publications?.at(-1);
    if (previous && previous.taskId === context.taskId && previous.agent === context.agent &&
        previous.sessionId === context.sessionId && previous.deferred === Boolean(context.deferred) &&
        previous.workspace === repoRoot && last?.head === result.commit && last.targetCommit === result.targetCommit &&
        last.baseCommit === publication?.baseCommit && last.reviewHash === publication?.reviewHash)
      return previous;
    const event = { taskId: context.taskId, sessionId: context.sessionId, agent: context.agent,
      prId: String(result.pullRequestId), branch: branch.replace(/^refs\/heads\//, ""),
      head: result.commit, targetCommit: result.targetCommit, checked: true, publishedAt: now,
      ...publication };
    const record = { version: 1, verified: true, originKind: "mcp",
      prId: String(result.pullRequestId), prUrl: result.url, branch: branch.replace(/^refs\/heads\//, ""),
      ...(result.targetBranch ? { targetBranch: result.targetBranch.replace(/^refs\/heads\//, "") } : {}),
      projectRoot: context.projectRoot, taskId: context.taskId, agent: context.agent,
      creatorName: context.agent, sessionId: context.sessionId, deferred: Boolean(context.deferred),
      taskWorkspace: context.taskWorkspace, workspace: repoRoot, originalPrompt: context.originalPrompt,
      registeredAt: previous?.registeredAt || now, publishedAt: now,
      publications: [...(previous?.publications || []), event] };
    write(file, record);
    return record;
  } finally { await release(); }
}
