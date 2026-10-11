import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { preparationBlocked } from "../packages/bohemia-pr-mcp/src/resume-state.mjs";
import { readJson, samePath, verifiedWorkspaceMigration } from "./spool-store.mjs";
import { createWithOrigin } from "../packages/bohemia-pr-mcp/src/pr-origin.mjs";
import { importInteractiveCreator, interactiveSessionOwner } from "./interactive-creator.mjs";
import { withAdmission } from "./admission.mjs";

export function normalizePrUrl(url) {
  if (typeof url !== "string") return "";
  return url.toLowerCase()
    .replace(/^https?:\/\/([^.]+)\.visualstudio\.com\//, "https://dev.azure.com/$1/")
    .replace(/^https?:\/\/dev\.azure\.com\//, "https://dev.azure.com/")
    .replace(/\/+$/, "");
}

export function samePrUrl(a, b) {
  return normalizePrUrl(a) === normalizePrUrl(b);
}

export function assertCreatorWorkspaceReleased(workspace) {
  if (!existsSync(workspace)) return;
  const git = (...args) => execFileSync("git", args, {
    cwd: workspace, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
  if (git("status", "--porcelain") || git("rev-list", "--max-count=1", "HEAD", "--not", "--remotes")) {
    throw preparationBlocked(`Previous checkout contains uncommitted or unpublished work; preserved at ${workspace}`, "unpublished_workspace");
  }
}

export function creatorBindings(store, registry) {
  if (registry && (registry.version !== 1 || !Array.isArray(registry.pullRequests))) throw new Error("Invalid verified creator registry");
  const nativeDirectory = path.join(store.records, "native-creators");
  let native = [];
  try { native = readdirSync(nativeDirectory).filter(name => name.endsWith(".json")).map(name => readJson(path.join(nativeDirectory, name))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return [...(registry?.pullRequests || []), ...native];
}

export function resolveSpoolCreator(store, pr) {
  const registry = readJson(path.join(store.records, "ownership.json"));
  const matches = creatorBindings(store, registry).filter(row =>
    String(row.prId) === String(pr.id) && samePrUrl(row.prUrl, pr.url));
  if (matches.length !== 1) throw new Error(`PR ${pr.id}: no unique verified originating work item`);
  const owner = matches[0];
  if (!owner.verified || owner.branch !== pr.branch || !samePrUrl(owner.prUrl, pr.url)) {
    throw new Error(`PR ${pr.id}: creator binding does not match this branch and PR`);
  }
  if (!owner.agent || owner.agent.startsWith("pr-updater")) throw new Error("A generic updater cannot own creator follow-ups");
  store.validateAgent(owner.agent);
  if (owner.originKind === "copilot_cli" && owner.creationEvidence?.sessionDirectory) {
    const pid = interactiveSessionOwner(store, owner.creationEvidence.sessionDirectory);
    if (pid) throw new Error(`PR ${pr.id}: verified original author session ${owner.sessionId} is active (PID ${pid}); awaiting its release without interruption`);
  }
  const task = store.task(owner.taskId);
  if (owner.deferred === true && (owner.originKind !== "spool_automation" ||
      !task?.deferred_pr_owner || task.turns !== 0 && !task.session_id)) {
    throw new Error(`PR ${pr.id}: invalid native deferred ownership`);
  }
  const metadata = store.metadata(owner.taskId);
  const migrated = task && verifiedWorkspaceMigration(metadata, owner.workspace, task.workspace) &&
    metadata.prId === String(pr.id) && metadata.contract?.branch === pr.branch &&
    metadata.contract?.identifier === owner.taskId;
  if (!task || task.agent !== owner.agent || (!samePath(task.workspace, owner.workspace) && !migrated)) {
    throw new Error(`PR ${pr.id}: imported work item ownership/workspace is inconsistent`);
  }
  const sessionId = owner.sessionId || owner.continuity?.sessionId;
  if (sessionId && task.session_id !== sessionId) {
    throw new Error(`PR ${pr.id}: originating Copilot session does not match the work item; continuation held`);
  }
  return { ...owner, assignedWorkspace: owner.workspace, workspace: task.workspace,
    ...(migrated ? { workspaceMigration: metadata.workspaceMigration } : {}), task };
}

export async function recoverSpoolCreator(store, pr, client, config) {
  const registry = readJson(path.join(store.records, "ownership.json"));
  const bindings = creatorBindings(store, registry).filter(owner => String(owner.prId) === String(pr.id) &&
      samePrUrl(owner.prUrl, pr.url));
  if (bindings.length) {
    const owner = bindings.length === 1 && bindings[0];
    if (owner?.verified && owner.originKind === "copilot_cli" && owner.branch === pr.branch && !store.task(owner.taskId)) {
      await withAdmission(store.root, owner.agent, () => importInteractiveCreator(store, owner),
        owner.workspace, owner.taskId);
    }
    return;
  }
  const directory = path.join(store.records, "native-creators");
  let intents;
  try {
    intents = readdirSync(path.join(directory, ".pending")).filter(name => name.endsWith(".json"))
      .map(name => readJson(path.join(directory, ".pending", name)));
  } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const scope = normalizePrUrl(pr.url).replace(/\d+$/, "").replace(/\/+$/, "");
  const matches = intents.filter(intent => intent?.attempted && normalizePrUrl(intent.scope).replace(/\/+$/, "") === scope &&
    intent.branch === pr.branch && pr.description?.startsWith(`<!-- bohemia-origin:${intent.originId} -->\n`));
  if (!matches.length) return;
  if (matches.length !== 1) throw new Error(`PR ${pr.id}: ambiguous pending creator records`);
  const intent = matches[0], owner = intent.owner;
  const task = store.task(owner.taskId);
  if (!["spool", "spool_automation"].includes(owner.originKind) || !task || task.agent !== owner.agent ||
      task.session_id !== owner.sessionId || !samePath(task.workspace, owner.workspace)) {
    throw new Error(`PR ${pr.id}: pending creation does not match its original work item/session`);
  }
  store.validateAgent(owner.agent);
  const raw = value => ({ pullRequestId: Number(value.id), description: value.description,
    sourceRefName: `refs/heads/${value.branch}`, targetRefName: `refs/heads/${value.targetBranch}` });
  await createWithOrigin({
    context: { ...owner, receiptDirectory: directory, branch: intent.branch },
    repoRoot: owner.workspace,
    input: { repository: intent.repository, sourceBranch: intent.branch, targetBranch: intent.targetBranch },
    api: {
      url: (_repository, id) => pr.url.replace(/\d+$/, String(id)),
      get: async (_repository, id) => raw(await client.getPullRequest(config, String(id), { refresh: true })),
      list: async () => (await client.listOwnPullRequests(config, {
        refresh: true, status: "all", sourceBranch: intent.branch, allPages: true,
      }))
        .filter(value => value.branch === intent.branch).map(raw),
      create: async () => { throw new Error("Ownership recovery cannot create a PR"); },
    },
  });
}
