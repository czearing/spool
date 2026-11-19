import path from "node:path";
import { taskHasPublication } from "./publications.mjs";
import { digest, readJson, samePath, verifiedWorkspaceMigration } from "./spool-store.mjs";
import { assignedChild, prArtifacts } from "./backlog-ado.mjs";
import { readNativeOutcome } from "./backlog-blocked.mjs";
import { nativeInvestigationProfile } from "./native-investigation-recovery.mjs";
import { continueTask, nativeReceipt } from "./native-continuation.mjs";
import { createMonitorControls } from "./monitor-controls.mjs";
import { azureDevOps } from "../packages/repository-mcp/src/azure-devops.mjs";
import { readCodespaceConfig } from "../packages/repository-mcp/src/codespaces/config.mjs";
import { CodespaceTransport } from "../packages/repository-mcp/src/codespaces/transport.mjs";
import { verifyEngineeringCodespace } from "../packages/repository-mcp/src/codespaces/engineering.mjs";

async function inspectPublication(profile, config, prepared) {
  const transport = new CodespaceTransport(profile);
  try {
    const current = await verifyEngineeringCodespace(prepared, { config: profile, transport });
    if (current.worktreeStatus !== "") return null;
    const host = azureDevOps({ ...config.ado,
      organization: config.ado.organization.startsWith("https://") ? config.ado.organization :
        `https://dev.azure.com/${config.ado.organization}` });
    if ((await host.list(current.branch)).length) return null;
    return current;
  } finally { await transport.dispose(); }
}

function ownedQueueWriteFailure(store, task) {
  const match = /^Failed to write task file ("(?:\\.|[^"])*"): Access is denied\. \(os error 5\)$/.exec(task.error);
  if (!match) return false;
  try {
    const file = JSON.parse(match[1]).replace(/^\\\\\?\\/, "");
    return samePath(file, path.join(store.root, "queues", "in_progress", `${task.id}.json`));
  } catch { return false; }
}

export async function recoverNativePublication({ store, config, task, workspace, entry, client, capacity,
  outcome = readNativeOutcome, inspect = inspectPublication, resume = continueTask,
  receipt = nativeReceipt, controls,
  readProfile = readCodespaceConfig, preparation = profile => readJson(path.join(profile.workspace, "preparation.json")) }) {
  if (config.repositoryProfile !== "1js" || task.agent !== config.agentId || task.status !== "failed" ||
      task.provider || task.acceptance || !task.error || !task.session_id || store.isPaused(task.agent) ||
      task.interaction?.paused ||
      taskHasPublication(store, task.id)) return null;
  const metadata = store.metadata(task.id);
  if ((!samePath(task.workspace, workspace) && !verifiedWorkspaceMigration(metadata, workspace, task.workspace)) ||
      metadata?.source !== "backlog" || !metadata.runner || metadata.handoff?.workItem?.id !== entry.itemId ||
      metadata.handoff.workItem.project !== config.workItemProject ||
      metadata.handoff.workItem.parent !== config.parentWorkItem) return null;
  const pending = task.interaction?.messages?.filter(message => message.status !== "delivered") || [];
  const queued = pending.length === 1 && pending[0].status === "queued" &&
    ownedQueueWriteFailure(store, task) && metadata.retryOf === task.id &&
    metadata.key?.startsWith(`${metadata.runner}:publication-recovery:`)
    ? receipt(store, metadata.key) : null;
  const queuedRetry = queued?.phase === "published" && queued.taskId === task.id &&
    queued.nativeMessageId === pending[0]?.id;
  if (pending.length && !queuedRetry) return null;
  const profile = readProfile(nativeInvestigationProfile(store, task, workspace));
  if (profile.purpose !== "engineering" || profile.remoteRoot !== "/workspaces/1JS" || !samePath(profile.workspace,
    store.workspaceIdentity(task.agent, workspace, task.session_config.provider))) throw new Error("Publication recovery workspace changed");
  const report = await outcome(profile, task);
  if (report?.scope !== "environment" || report.outcome !== "partial") return null;
  if (report.version !== 1 || report.taskId !== task.id || report.workItemId !== entry.itemId ||
      !/^[a-f0-9]{40}$/.test(report.sourceCommit || "") ||
      typeof report.reason !== "string" || !report.reason.trim() || report.reason.length > 4000 ||
      !Array.isArray(report.evidence) || !report.evidence.length ||
      report.evidence.some(value => typeof value !== "string" || !value.trim() || value.length > 2000))
    throw new Error("Invalid partial native publication outcome; original work held");
  const held = { dispatched: 0, taskId: task.id,
    holding: "Committed native work requires fresh verified MCP environment recovery before publication retry" };
  const prepared = preparation(profile), time = Date.parse(prepared?.updatedAt);
  if (prepared?.ready !== true || !samePath(prepared.repoRoot, profile.workspace) ||
      prepared.commit !== report.sourceCommit || !Number.isFinite(time) ||
      !Number.isFinite(Date.parse(task.updated_at)) ||
      (queuedRetry ? metadata.preparation?.ready !== true ||
        metadata.preparation.commit !== prepared.commit || metadata.preparation.branch !== prepared.branch ||
        metadata.preparation.updatedAt !== prepared.updatedAt ||
        metadata.preparation.configSha256 !== prepared.configSha256 ||
        !samePath(metadata.preparation.repoRoot, prepared.repoRoot) ||
        !Number.isFinite(Date.parse(metadata.retryFailedAt)) || time <= Date.parse(metadata.retryFailedAt)
        : time <= Date.parse(task.updated_at))) return held;
  const eligible = async () => {
    const item = await client.item(entry.itemId);
    return assignedChild(config, item) && await client.isOpen(item) && !prArtifacts(item).length &&
      !(await capacity()).holding;
  };
  store.assertIdle(task.agent, workspace);
  if (!await eligible()) return held;
  const current = await inspect(profile, config, prepared);
  if (!current || current.commit !== report.sourceCommit || current.branch !== prepared.branch ||
      current.worktreeStatus !== "") return held;
  const key = `${metadata.runner}:publication-recovery:${digest(JSON.stringify([
    task.id, task.updated_at, task.error, report.sourceCommit, prepared.updatedAt, prepared.configSha256]))}`;
  if (store.submission(key)) return { ...held, holding: "Native publication recovery already accepted" };
  store.assertIdle(task.agent, workspace);
  if (!await eligible()) return held;
  if (queuedRetry) {
    const id = digest(`native-queue-write:${task.id}:${queued.nativeMessageId}`).slice(0, 32)
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    const control = controls || createMonitorControls(store);
    if (control.receipt(id)) return { ...held, holding: "Original queued-input admission already attempted; inspect its result" };
    control.submit({ id, kind: "status", taskId: task.id, status: "in_progress", expectedStatus: "failed" });
    return { ...held, holding: "Admitting original verified queued input after its owned task-file write failed" };
  }
  await resume(store, { key, agent: task.agent, workspace: profile.workspace, resumeId: task.id,
    expectedUpdatedAt: task.updated_at,
    prompt: "Preparation recovered; retry this original task's publication through repository MCP, " +
      "preserving its implementation and evidence.",
    metadata: { ...metadata, preparation: prepared, retryOf: task.id, retryFailedAt: task.updated_at,
      independentWorkspace: false, key, phase: undefined, publishedAt: undefined,
      ...(!samePath(task.workspace, profile.workspace) ? { workspaceMigration: {
        reason: "assigned_agent_workspace", previousWorkspace: task.workspace,
        originalWorkspace: metadata.workspaceMigration?.originalWorkspace || task.workspace,
        assignedWorkspace: profile.workspace,
      } } : {}) } });
  return { dispatched: 0, taskId: task.id, holding: "Retrying original native publication after verified MCP environment recovery" };
}
