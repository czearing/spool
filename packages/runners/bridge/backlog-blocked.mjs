import path from "node:path";
import { taskHasPublication } from "./publications.mjs";
import { digest, readJson, samePath } from "./spool-store.mjs";
import { assignedChild } from "./backlog-ado.mjs";
import { inspectUnchangedInvestigation, nativeInvestigationProfile } from "./native-investigation-recovery.mjs";
import { readCodespaceConfig, shellQuote } from "../packages/repository-mcp/src/codespaces/config.mjs";
import { CodespaceTransport } from "../packages/repository-mcp/src/codespaces/transport.mjs";

export async function readNativeOutcome(profile, task) {
  const file = `${profile.remoteTools}/jobs/task-${task.id}-outcome.json`;
  const script = `const fs=require("node:fs"),p=${JSON.stringify(file)};` +
    `if(!fs.existsSync(p)){console.log("null");process.exit(0);}` +
    `const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.size>32768)` +
    `throw Error("Unsafe work-item outcome");console.log(JSON.stringify(JSON.parse(fs.readFileSync(p,"utf8"))));`;
  const transport = new CodespaceTransport(profile);
  try {
    await transport.environment();
    const { stdout } = await transport.ssh(`${shellQuote(profile.nativeProfile.nodeExecutable)} -e ${shellQuote(script)}`);
    return JSON.parse(stdout);
  } finally { await transport.dispose(); }
}

export async function reconcileBlockedBacklog({ store, config, task, workspace, entry, client, save,
  inspect = inspectUnchangedInvestigation, outcome = readNativeOutcome, readProfile = readCodespaceConfig }) {
  if (config.repositoryProfile !== "1js" || task.status !== "failed" || task.provider || task.acceptance ||
      !task.session_id || !task.error || task.interaction?.paused ||
      task.interaction?.messages?.some(message => message.status !== "delivered") ||
      taskHasPublication(store, task.id)) return false;
  const item = await client.item(entry.itemId);
  const failure = digest(JSON.stringify([task.id, task.updated_at, task.error]));
  if (entry.blocked?.taskId === task.id && entry.blocked.failure === failure) return true;
  if (!assignedChild(config, item) || !await client.isOpen(item)) return false;
  const profile = readProfile(nativeInvestigationProfile(store, task, workspace));
  if (profile.purpose !== "engineering" || !samePath(profile.workspace,
    store.workspaceIdentity(task.agent, workspace, task.session_config.provider))) throw new Error("Blocked work-item workspace changed");
  const report = await outcome(profile, task);
  if (!report || report.scope === "environment") return false;
  if (report.version !== 1 || report.taskId !== task.id || report.workItemId !== entry.itemId ||
      !["blocked", "partial"].includes(report.outcome) || report.scope !== "work-item" ||
      typeof report.reason !== "string" || !report.reason.trim() || report.reason.length > 4000 ||
      !/^[a-f0-9]{40}$/i.test(report.sourceCommit || "") ||
      !Array.isArray(report.evidence) || !report.evidence.length ||
      report.evidence.some(value => typeof value !== "string" || !value.trim() || value.length > 2000))
    throw new Error("Invalid work-item-specific blocker outcome; assignment held");
  if (report.outcome === "partial") return false;
  store.assertIdle(task.agent, workspace);
  const proof = await inspect(profile, config);
  if (!proof || proof.commit !== report.sourceCommit) return false;
  entry.blocked = { taskId: task.id, failure, verifiedAt: new Date().toISOString(),
    branch: proof.branch, commit: proof.commit, reason: report.reason, evidence: report.evidence };
  save();
  return true;
}
