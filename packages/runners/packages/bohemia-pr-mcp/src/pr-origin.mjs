import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { acquireProcessLock, writeRunnerJson } from "../../bohemia-agent-tooling/src/index.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const branchName = branch => branch.replace(/^refs\/heads\//, "");
const canonical = directory => {
  const value = realpathSync.native(directory);
  return process.platform === "win32" ? value.toLowerCase() : value;
};
const read = file => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
const marker = id => `<!-- bohemia-origin:${id} -->\n`;
const validSession = owner => uuid.test(owner?.sessionId || "") ||
  (owner?.originKind === "spool_automation" && owner.deferred === true && owner.sessionId === null);

export function preservePrOrigin(previous, description) {
  const prefix = previous?.match(/^<!-- bohemia-origin:([0-9a-f-]{36}) -->\r?\n/i);
  return prefix && uuid.test(prefix[1]) ? marker(prefix[1]) + description : description;
}

export function creationContext(environment = process.env) {
  const file = environment.BOHEMIA_CREATOR_CONTEXT;
  if (!file) {
    if (!environment.COPILOT_SESSION_ID) return null;
    if (!uuid.test(environment.COPILOT_SESSION_ID)) throw new Error("Invalid originating Copilot session ID");
    return {
      version: 1, originKind: "copilot", sessionId: environment.COPILOT_SESSION_ID,
      taskId: null, agent: null, workspace: null, branch: null,
      receiptDirectory: path.join(homedir(), ".bohemia-pr-mcp", "pr-origins"),
    };
  }
  if (!path.isAbsolute(file)) throw new Error("Creator context must be an absolute execution-context path");
  const context = read(file);
  if (context?.version === 2 && context.originKind === "spool_automation") {
    if (!safeId.test(context.taskId || "") || !safeId.test(context.agent || "") ||
        context.agent === "pr-reviewer" || context.agent.startsWith("pr-updater") ||
        context.sessionId !== null || context.deferred !== true ||
        !path.isAbsolute(context.nativeRoot || "") || !path.isAbsolute(context.workspace || "") ||
        typeof context.receiptDirectory !== "string" || !path.isAbsolute(context.receiptDirectory) ||
        typeof context.branch !== "string" || !context.branch.trim() ||
        !/^[0-9a-f]{40}$/i.test(context.commit || "") ||
        canonical(file) !== canonical(path.join(context.nativeRoot, ".runner-receipts", "creator-contexts", `${context.taskId}.json`)) ||
        canonical(context.receiptDirectory) !== canonical(path.join(context.nativeRoot, ".runner-receipts", "native-creators"))) {
      throw new Error("Invalid native deferred creator context");
    }
    const task = read(path.join(context.nativeRoot, "queues", "completed", `${context.taskId}.json`));
    if (!task || task.id !== context.taskId || task.agent !== context.agent || !task.deferred_pr_owner ||
        task.session_id != null || task.session_config != null || task.provider != null ||
        task.turns !== 0 || task.status !== "completed" ||
        canonical(task.workspace) !== canonical(context.workspace)) {
      throw new Error("Deferred creation requires a dormant native owner, not an invented provider session");
    }
    return context;
  }
  const providerBound = typeof context?.providerToken === "string" && context.providerToken.startsWith("spool-provider-") &&
    uuid.test(context.providerToken.slice("spool-provider-".length)) &&
    context.providerToken === environment.SPOOL_PROVIDER_TOKEN;
  const sessionBound = context?.sessionId === environment.COPILOT_SESSION_ID ||
    (!environment.COPILOT_SESSION_ID && providerBound);
  if (!context || context.version !== 1 || context.originKind !== "spool" ||
      !safeId.test(context.taskId || "") || !safeId.test(context.agent || "") ||
      context.agent.startsWith("pr-updater") || context.agent === "pr-reviewer" ||
      !uuid.test(context.sessionId || "") || !sessionBound ||
      (context.workspace != null && (typeof context.workspace !== "string" || !path.isAbsolute(context.workspace))) ||
      typeof context.receiptDirectory !== "string" || !path.isAbsolute(context.receiptDirectory) ||
      (context.branch != null && (typeof context.branch !== "string" || !context.branch.trim()))) {
    throw new Error("Missing or inconsistent original creator execution context; PR creation refused");
  }
  return context;
}

function sameOwner(record, owner) {
  return record.originKind === owner.originKind && record.taskId === owner.taskId &&
    record.agent === owner.agent && canonical(record.workspace) === canonical(owner.workspace);
}

// The intent precedes POST. Its opaque marker lets a retry find the remote result
// even if the response or the local receipt was lost. An ambiguous POST is never replayed.
export async function createWithOrigin({ context, input, repoRoot, api, write = writeRunnerJson }) {
  if (!context) return api.create(input);
  if (!repoRoot || (context.workspace && canonical(context.workspace) !== canonical(repoRoot)) ||
      (context.branch && branchName(context.branch) !== branchName(input.sourceBranch))) {
    throw new Error("Publication checkout/branch does not match the original creator");
  }
  const scope = api.url(input.repository, 0).replace(/0$/, "").toLowerCase();
  const branch = branchName(input.sourceBranch), targetBranch = branchName(input.targetBranch);
  const directory = context.receiptDirectory;
  mkdirSync(path.join(directory, ".pending"), { recursive: true });
  const key = context.taskId || `${context.sessionId}-${createHash("sha256").update(scope + branch).digest("hex").slice(0, 16)}`;
  const receiptFile = path.join(directory, `${key}.json`);
  const intentFile = path.join(directory, ".pending", `${key}.json`);
  const releaseOwner = await acquireProcessLock(`${canonical(directory)}:${key}`, { namespace: "bohemia-pr-owner", timeoutMs: 30_000 });
  let releaseBranch;
  try {
    releaseBranch = await acquireProcessLock(`${scope.toLowerCase()}${branch}`, { namespace: "bohemia-pr-create", timeoutMs: 30_000 });
    const owner = {
      originKind: context.originKind, taskId: context.taskId, agent: context.agent,
      creatorName: context.agent, sessionId: context.sessionId, workspace: context.workspace || repoRoot,
      originalPrompt: context.originalPrompt,
      ...(context.originKind === "spool_automation" ? { deferred: true } : {}),
    };
    const existing = read(receiptFile);
    let intent = read(intentFile);
    if (existing && (existing.scope !== scope || existing.branch !== branch || !sameOwner(existing, owner))) {
      throw new Error("This work item already owns a different original PR; use action=update");
    }
    if (intent && (intent.version !== 1 || intent.scope !== scope || intent.branch !== branch ||
        !validSession(intent.owner) ||
        intent.targetBranch !== targetBranch || !sameOwner(intent.owner, owner) || !uuid.test(intent.originId))) {
      throw new Error("Creation intent belongs to a different PR or original owner");
    }
    if (existing && (!intent || existing.verified !== true || existing.originId !== intent.originId ||
        existing.sessionId !== intent.owner.sessionId ||
        existing.prUrl?.toLowerCase() !== api.url(input.repository, Number(existing.prId)).toLowerCase() ||
        existing.targetBranch !== intent.targetBranch)) {
      throw new Error("Existing creator receipt has no matching creation intent; refusing to replace ownership");
    }
    if (!intent) {
      intent = { version: 1, scope, repository: input.repository, branch, targetBranch, owner,
        originId: randomUUID(), attempted: false, createdAt: new Date().toISOString() };
      write(intentFile, intent);
    }
    let pr;
    const knownId = existing?.prId || intent.prId;
    if (knownId) {
      pr = await api.get(input.repository, Number(knownId));
    } else {
      const candidates = await api.list(input.repository, branch);
      const matches = candidates.filter(candidate => candidate.description?.startsWith(marker(intent.originId)));
      if (matches.length > 1) throw new Error("Multiple PRs match the creation intent; ownership is ambiguous");
      if (matches.length === 1) {
        pr = await api.get(input.repository, matches[0].pullRequestId);
      } else if (intent.attempted) {
        throw new Error("PR creation outcome is uncertain; retry reconciliation, never create a replacement PR");
      } else if (candidates.length) {
        throw new Error("This branch already has a PR without this creation receipt; recover its original owner instead");
      } else {
        intent = { ...intent, attempted: true };
        write(intentFile, intent);
        try {
          pr = await api.create({ ...input, description: marker(intent.originId) + input.description });
        } catch (error) {
          if (error.creationRejected === true && error.status === 400 &&
              error.typeKey === "GitPullRequestCannotBeActivated") {
            write(intentFile, { ...intent, attempted: false, rejection: {
              status: error.status, typeKey: error.typeKey, message: error.message, at: new Date().toISOString(),
            } });
          }
          throw error;
        }
        pr = await api.get(input.repository, pr.pullRequestId);
      }
    }
    if (!Number.isSafeInteger(pr.pullRequestId) || pr.pullRequestId <= 0 ||
        branchName(pr.sourceRefName || "") !== branch || branchName(pr.targetRefName || "") !== targetBranch ||
        !pr.description?.startsWith(marker(intent.originId)) ||
        (existing && String(pr.pullRequestId) !== existing.prId)) {
      throw new Error("Remote PR does not match the original creation intent");
    }
    if (!existing) {
      write(receiptFile, { version: 1, ...intent.owner, verified: true, scope, repository: input.repository,
        branch, targetBranch, originId: intent.originId, prId: String(pr.pullRequestId),
        prUrl: api.url(input.repository, pr.pullRequestId), registeredAt: intent.createdAt });
    }
    write(intentFile, { ...intent, prId: String(pr.pullRequestId) });
    return pr;
  } finally {
    try { await releaseBranch?.(); }
    finally { await releaseOwner(); }
  }
}
