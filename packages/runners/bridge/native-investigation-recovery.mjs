import path from "node:path";
import { digest, readJson, safeId, samePath, verifiedWorkspaceMigration, writeJson } from "./spool-store.mjs";
import { createMonitorControls } from "./monitor-controls.mjs";
import { azureDevOps } from "../packages/repository-mcp/src/azure-devops.mjs";
import { readCodespaceConfig, shellQuote } from "../packages/repository-mcp/src/codespaces/config.mjs";
import { CodespaceTransport } from "../packages/repository-mcp/src/codespaces/transport.mjs";
import { verifyEngineeringCodespace } from "../packages/repository-mcp/src/codespaces/engineering.mjs";
import { CodespaceRequests } from "../packages/repository-mcp/src/codespaces/github-requests.mjs";

export async function inspectUnchangedInvestigation(profile, config, dependencies = {}) {
  const prepared = readJson(path.join(profile.workspace, "preparation.json"));
  if (!prepared?.ready) return null;
  const transport = dependencies.transport || new CodespaceTransport(profile);
  try {
    const current = await verifyEngineeringCodespace(prepared, { config: profile, transport, allowWork: true });
    const command = `git -C ${shellQuote(profile.remoteRoot)} rev-list --count ${
      shellQuote(`refs/remotes/origin/${profile.nativeProfile.baseBranch}..HEAD`)}`;
    const { stdout } = await transport.ssh(command);
    if (current.worktreeStatus !== "" || stdout.trim() !== "0") return null;
    const host = azureDevOps({ ...config.ado,
      organization: config.ado.organization.startsWith("https://") ? config.ado.organization :
        `https://dev.azure.com/${config.ado.organization}` });
    if ((await host.list(current.branch)).length) return null;
    return { branch: current.branch, commit: current.commit, configSha256: prepared.configSha256,
      preparation: prepared };
  } finally { await transport.dispose(); }
}

export function nativeInvestigationProfile(store, task, workspace) {
  const provider = readJson(path.join(store.root, "spool.json"))?.copilotProviders?.[task.agent];
  const args = provider?.args, index = Array.isArray(args) ? args.indexOf("--config") : -1;
  if (index < 0 || !path.isAbsolute(args[index + 1] || "") ||
      !args.some(arg => /(?:^|[\\/])codespaces[\\/]copilot\.mjs$/.test(arg)) ||
      provider.workingDirectory !== "/workspaces/1JS" ||
      (task.session_id || task.session_config?.provider) &&
        JSON.stringify(task.session_config?.provider) !== JSON.stringify(provider))
    throw new Error("Native investigation recovery ownership changed");
  return args[index + 1];
}

export async function recoverNativeInvestigation({ store, config, task, workspace, capacity,
  readProfile = readCodespaceConfig, now = Date.now, controls, requests }) {
  if (config.repositoryProfile !== "1js" || task?.agent !== config.agentId ||
      task.status !== "failed" || task.provider || task.acceptance || !task.error ||
      store.isPaused(task.agent) || task.interaction?.paused) return null;
  const metadata = store.metadata(task.id);
  if (!samePath(task.workspace, workspace) && !verifiedWorkspaceMigration(metadata, workspace, task.workspace)) return null;
  const source = metadata?.source || metadata?.runner;
  if (!metadata?.runner || !(source === "perf" && metadata.handoff?.discovery ||
      source === "backlog" && Number.isSafeInteger(metadata.handoff?.workItem?.id))) return null;
  const profile = readProfile(nativeInvestigationProfile(store, task, workspace));
  if (profile.purpose !== "engineering" || profile.remoteRoot !== "/workspaces/1JS" ||
      !samePath(profile.workspace, store.workspaceIdentity(task.agent, workspace, task.session_config?.provider)))
    throw new Error("Native investigation recovery workspace changed");
  if (profile.githubAccount) {
    try { (requests || new CodespaceRequests(profile.githubAccount)).check(profile.codespace); }
    catch (error) {
      if (!["GITHUB_RATE_LIMITED", "CODESPACE_UNAVAILABLE"].includes(error.code)) throw error;
      return { dispatched: 0, taskId: task.id, holding: error.message, retryAt: error.retryAt };
    }
  }
  const failure = digest(JSON.stringify([task.id, task.updated_at, task.error]));
  const file = path.join(store.records, "native-investigations", `${safeId(task.id)}.json`);
  const previous = readJson(file);
  const pending = (task.interaction?.messages || []).filter(message => message.status !== "delivered");
  if (pending.some(message => message.status !== "queued"))
    return { dispatched: 0, taskId: task.id, holding: "Prior input delivery is uncertain; automatic replay held" };
  const failedAt = Date.parse(task.updated_at);
  if (!Number.isFinite(failedAt)) throw new Error("Failed native task has no valid failure timestamp");
  const attempt = previous?.failure === failure ? previous.attempt : (previous?.attempt || 0) + 1;
  const backoffUntil = previous?.failure === failure ? previous.retryAt
    : new Date(Math.max(failedAt, Date.parse(previous?.resumedAt) || 0) +
      Math.min(60000 * 2 ** Math.min(attempt - 1, 5), 1800000)).toISOString();
  const rateLimited = (previous?.failure !== failure || !previous.admissionAttempt) &&
    /(?:GitHub|API|HTTP 403).{0,80}rate limit|GITHUB_RATE_LIMITED/i.test(task.error);
  const retryAt = rateLimited ? new Date(Math.min(Date.parse(backoffUntil), now())).toISOString() : backoffUntil;
  const record = previous?.failure === failure
    ? previous.retryAt === retryAt ? previous : { ...previous, retryAt } : {
    taskId: task.id, failure, attempt, retryAt,
    failures: [...(previous?.failures || []), { failure, failedAt: task.updated_at, error: task.error, retryAt }],
  };
  if (record !== previous) writeJson(file, record);
  const holding = detail => ({ dispatched: 0, taskId: task.id, holding: detail, retryAt, recoveryAttempt: attempt });
  const key = `${metadata.runner}:task-recovery:${failure}${record.admissionAttempt ? `:admission-${record.admissionAttempt}` : ""}`;
  const admission = controls || createMonitorControls(store);
  const id = digest(key).slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  const existing = admission.receipt(id);
  if (existing?.result?.status === "failed") {
    const nextAttempt = attempt + 1;
    const nextRetry = new Date(now() + Math.min(60000 * 2 ** Math.min(nextAttempt - 1, 5), 1800000)).toISOString();
    writeJson(file, { ...record, attempt: nextAttempt, admissionAttempt: (record.admissionAttempt || 0) + 1,
      retryAt: nextRetry, failures: [...record.failures, { phase: "admission", failedAt: new Date(now()).toISOString(),
        error: existing.result.error, retryAt: nextRetry }] });
    return { ...holding(`Native admission failed; retrying original task after backoff: ${existing.result.error}`),
      retryAt: nextRetry, recoveryAttempt: nextAttempt };
  }
  if (existing) return holding("Original task recovery already accepted or pending");
  if (now() < Date.parse(retryAt)) return holding(`Retrying original task after backoff at ${retryAt}`);
  const available = await capacity();
  if (available.holding) return holding(available.holding);
  store.assertIdle(task.agent, workspace);
  const current = store.task(task.id);
  if (current?.status !== "failed" || current.updated_at !== task.updated_at ||
      current.session_id !== task.session_id) return holding("Original task changed; rescanning before recovery");
  admission.submit({ id, kind: "status", taskId: task.id, status: "in_progress", expectedStatus: "failed" });
  writeJson(file, { ...record, resumedAt: new Date(now()).toISOString() });
  return holding("Resuming original failed task with its saved session and work");
}
