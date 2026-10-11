import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { engine, profile } from "./sources.mjs";
import { SpoolStore, readJson, samePath, safeId, writeJson } from "./spool-store.mjs";
import { withAdmission } from "./admission.mjs";

const aliases = {
  SoftwareEngineerPerformance: "perf", "SoftwareEngineer 2": "software-engineer",
  TechWriter: "tech-writer", PRReviewer: "pr-reviewer", PRUpdater: "pr-updater",
  "PRUpdater 2": "pr-updater", ChiefOfStaff: "chief-of-staff",
  PerfEngineManager: "perf-engine-manager", PromptEngineer: "prompt-engineer",
};

export async function migratePaperclip({ store, config, get, apply = false, ado }) {
  const { resolveCreator, creatorCheckout } = await engine("lib/creator-review.mjs");
  const { adoClient } = await engine("pr-updater/lib/pipeline.mjs");
  const agents = await get(`/companies/${config.paperclipCompanyId}/agents`);
  if (!Array.isArray(agents)) throw new Error("Invalid migration agent response");
  const issues = [], seen = new Set();
  for (;;) {
    const page = await get(`/companies/${config.paperclipCompanyId}/issues?limit=1000&offset=${issues.length}`);
    if (!Array.isArray(page)) throw new Error("Invalid migration issue response");
    if (!page.length) break;
    for (const issue of page) {
      safeId(issue.identifier);
      if (issue.companyId !== config.paperclipCompanyId || seen.has(issue.id)) {
        throw new Error("Migration issue pagination repeated an item or crossed company boundaries");
      }
      seen.add(issue.id);
      issues.push(issue);
    }
  }
  const agentMap = Object.fromEntries(agents.map(agent => {
    const slug = aliases[agent.name];
    if (!slug) throw new Error(`No explicit Spool identity mapping for ${agent.name}`);
    store.validateAgent(slug);
    return [agent.id, slug];
  }));
  const migrate = async () => {
    const tasks = store.tasks(), live = store.liveTasks(tasks);
    if (apply && (live.length || tasks.some(t => ["incoming", "in_progress"].includes(t.status)))) {
      throw new Error("Migration requires idle Spool queues and sessions");
    }
    const taskById = new Map(tasks.map(task => [task.id, task]));
    const restoredMissing = [];
    for (const issue of issues) {
      if (taskById.has(issue.identifier)) continue;
      restoredMissing.push(issue.identifier);
      const status = issue.status === "cancelled" ? "failed" : "completed";
      taskById.set(issue.identifier, {
        id: issue.identifier, agent: agentMap[issue.assigneeAgentId] || "unassigned",
        title: issue.title, prompt: issue.description || "", workspace: null, session_id: null,
        status, created_at: issue.createdAt, updated_at: issue.updatedAt, comments: [], cost: {}, turns: 0,
        file: path.join(store.queues, status, `${issue.identifier}.json`),
      });
    }
    const prRecords = [], excluded = [];
    const prs = await (ado || adoClient).listOwnPullRequests(config, { refresh: true });
    const fetchImpl = async url => {
      const parsed = new URL(url);
      const route = parsed.pathname.slice("/api".length) + parsed.search;
      return { ok: true, json: () => get(route) };
    };
    for (const pr of prs) {
      let creator;
      try { creator = await resolveCreator(config, pr, fetchImpl); }
      catch (error) {
        if (error.code !== "CREATOR_OWNERSHIP_UNVERIFIED") throw error;
        excluded.push({ prId: String(pr.id), reason: error.message });
        continue;
      }
      const { issue, agent, creationRunId } = creator;
      if (!taskById.has(issue.identifier)) throw new Error(`Missing imported original work item ${issue.identifier}`);
      let workspace = creatorCheckout(config, issue, pr);
      if (!existsSync(workspace)) {
        const candidate = issue.project?.workspaces?.find(w => w.id === issue.projectWorkspaceId)?.cwd;
        if (!candidate || !existsSync(candidate)) {
          excluded.push({ prId: String(pr.id), reason: `Original workspace unavailable for ${issue.identifier}` });
          continue;
        }
        workspace = candidate;
      }
      const runs = await get(`/issues/${issue.id}/runs`);
      let continuity = null;
      for (const candidate of runs.filter(r => r.agentId === agent.id).slice(0, 8)) {
        const run = await get(`/heartbeat-runs/${candidate.runId || candidate.id}`);
        if (run.sessionIdAfter && samePath(run.contextSnapshot?.paperclipWorkspace?.cwd, workspace)) {
          continuity = { sessionId: run.sessionIdAfter, runId: run.id, workspace };
          break;
        }
      }
      const currentTask = taskById.get(issue.identifier);
      if (store.metadata(issue.identifier)?.creator && currentTask.session_id) {
        continuity = { sessionId: currentTask.session_id, source: "spool", workspace: currentTask.workspace };
      }
      const previousImport = readJson(path.join(store.records, "imports", `${issue.identifier}.json`));
      prRecords.push({ verified: true, prId: String(pr.id), prUrl: pr.url, branch: pr.branch,
        taskId: issue.identifier, sourceIssueId: issue.id, sourceAgentId: agent.id,
        agent: agentMap[agent.id], creatorName: agent.name, workspace, continuity,
        creationRunId, originalPrompt: previousImport?.previousTask?.prompt || currentTask.prompt });
    }
    const bindings = new Map(prRecords.map(record => [record.taskId, record]));
    const records = [], missing = [];
    for (let index = 0; index < issues.length; index += 4) {
      await Promise.all(issues.slice(index, index + 4).map(async issue => {
        const task = taskById.get(issue.identifier);
        if (!task) { missing.push(issue.identifier); return; }
        const comments = await get(`/issues/${issue.id}/comments`);
        if (!Array.isArray(comments)) throw new Error(`Invalid comments for ${issue.identifier}`);
        const binding = bindings.get(issue.identifier);
        const mappedAgent = binding?.agent || agentMap[issue.assigneeAgentId];
        const snapshot = { source: "paperclip", companyId: config.paperclipCompanyId, issue,
          comments, previousTask: task, originalAgentId: binding?.sourceAgentId || issue.assigneeAgentId,
          mappedAgent: mappedAgent || null, creator: binding || null };
        records.push({ taskId: task.id, sourceIssueId: issue.id, sourceStatus: issue.status,
          mappedAgent: mappedAgent || null, creatorVerified: !!binding, workspace: binding?.workspace || task.workspace });
        if (!apply) return;
        const backup = path.join(store.records, "imports", `${task.id}.json`);
        if (!existsSync(backup)) writeJson(backup, snapshot);
        const restored = { ...task, ...(mappedAgent ? { agent: mappedAgent } : {}),
          ...(binding ? { workspace: binding.workspace, session_id: binding.continuity?.sessionId || null } : {}) };
        delete restored.file;
        const known = new Set((restored.comments || []).map(c => `${c.created_at}|${c.message || c.content}`));
        restored.comments = [...(restored.comments || [])];
        for (const comment of comments) {
          const key = `${comment.createdAt}|${comment.body}`;
          if (!known.has(key)) {
            restored.comments.push({ author: comment.authorAgentId || comment.authorUserId || "source",
              message: comment.body, created_at: comment.createdAt });
            known.add(key);
          }
        }
        // Never enqueue old backlog or erase a failed execution during a mapping repair.
        writeJson(task.file, restored);
      }));
    }
    if (missing.length) throw new Error(`Missing imported work items: ${missing.join(", ")}`);
    const result = { version: 1, migratedAt: new Date().toISOString(), companyId: config.paperclipCompanyId,
      agentMap, tasks: records, pullRequests: prRecords, excluded, restoredMissing };
    const previousRegistry = readJson(path.join(store.records, "ownership.json"));
    if (previousRegistry?.verificationPrIds) result.verificationPrIds = previousRegistry.verificationPrIds;
    if (apply) writeJson(path.join(store.records, "ownership.json"), result);
    return result;
  };
  if (!apply) return migrate();
  const identities = [...new Set(Object.values(agentMap))].sort();
  const admit = index => index === identities.length ? migrate()
    : withAdmission(store.root, identities[index], () => admit(index + 1));
  const result = await admit(0);
  if (result.holding) throw new Error(`Migration requires idle runner preparation: ${result.holding}`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = profile("pr-updater");
  const input = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "spool-runners.json"), "utf8"));
  const option = name => {
    const index = process.argv.indexOf(name);
    return index < 0 ? null : process.argv[index + 1];
  };
  if (option("--paperclip-url")) config.paperclipApiUrl = option("--paperclip-url");
  if (option("--company-id")) config.paperclipCompanyId = option("--company-id");
  if (option("--spool-root")) input.spool_dir = option("--spool-root");
  config.creatorId = input.ado?.creator_id || config.creatorId;
  config.authorAccount = input.ado?.author_account || config.authorAccount;
  if (!config.paperclipApiUrl || !config.paperclipCompanyId || !config.creatorId) {
    throw new Error("Migration requires --paperclip-url, --company-id and ado.creator_id in the local configuration");
  }
  const get = async route => {
    const response = await fetch(`${config.paperclipApiUrl}/api${route}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Migration source ${route}: ${response.status}`);
    return response.json();
  };
  const result = await migratePaperclip({ store: new SpoolStore(input.spool_dir), config, get, apply: process.argv.includes("--apply") });
  console.log(JSON.stringify({ tasks: result.tasks.length, agents: result.agentMap,
    creators: result.pullRequests.map(({ prId, taskId, agent, workspace, continuity }) => ({ prId, taskId, agent, workspace, session: continuity?.sessionId || null })),
    excluded: result.excluded, restoredMissing: result.restoredMissing.length }, null, 2));
}
