import { readFileSync } from "node:fs";
import path from "node:path";
import { engine } from "./sources.mjs";
import { safeId, readJson } from "./spool-store.mjs";
import { creatorBindings } from "./creator-routing.mjs";
import { createAgentDashboard } from "./agent-dashboard.mjs";

const { createFleetDashboardLoader } = await engine("pr-updater/lib/dashboard.mjs");
const { createDashboardHandler } = await engine("pr-updater/lib/dashboard-handler.mjs");
const { summarize } = await engine("pr-updater/lib/telemetry.mjs");
const { escapeHtml } = await engine("pr-updater/lib/dashboard-parts.mjs");
const { readAdoMetrics } = await engine("lib/ado-transport.mjs");

function transcript(store, task) {
  let log = "";
  try { log = readFileSync(path.join(store.root, "logs", `${safeId(task.id)}.log`), "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return [log, ...(task.comments || []).map(c => `${c.author || "unknown"}: ${c.message || c.content || ""}`)]
    .filter(Boolean).join("\n\n") || null;
}

function taskJob(store, task, recorded, metadata, live, baseUrl, imported) {
  const active = live || ["incoming", "in_progress"].includes(task.status);
  const prId = metadata?.prId ?? (/^pr-update-([1-9][0-9]*)$/.exec(task.id)?.[1]);
  const jobId = recorded?.jobId || `spool:${task.id}`;
  const state = active ? task.status === "incoming" ? "queued" : "dispatched"
    : task.status === "failed" ? "failed" : "done";
  const job = {
    ...recorded, jobId, taskId: task.id, prId: recorded?.prId ?? prId,
    agent: task.agent, agentName: task.agent, state,
    at: task.updated_at, queuedAt: recorded?.queuedAt || task.created_at,
    dispatchedAt: recorded?.dispatchedAt || (task.session_id ? task.created_at : null),
    doneAt: active ? null : task.updated_at,
    outcome: active ? null : task.status === "failed" ? "failed" : recorded?.outcome || "Spool completed; PR outcome unverified",
    reason: recorded?.reason || task.title,
    workspace: task.workspace, sessionId: task.session_id, turns: task.turns,
    costUsd: task.cost?.total_cost_usd ?? task.cost?.cost_usd,
    error: task.error || recorded?.error,
    issueId: task.id, identifier: task.id,
    issueUrl: `${baseUrl}/job?id=${encodeURIComponent(jobId)}`,
    runUrl: `${baseUrl}/job?id=${encodeURIComponent(jobId)}`,
    steps: recorded?.steps || metadata?.preparation?.steps,
    spoolStatus: task.status, liveSession: !!live,
  };
  if (metadata?.contract) {
    const proof = readJson(path.join(store.records, `verification-${task.id}.json`));
    job.creatorRevision = true;
    if (!active && task.status === "completed") {
      const matched = proof?.submissionId === metadata.key;
      job.state = matched ? proof.ok ? "done" : "failed" : "verifying";
      job.outcome = matched ? proof.ok ? "verified PR update" : "verification blocked" : "awaiting PR verification";
      job.error = matched && !proof.ok ? proof.reason : job.error;
    }
  } else if (imported && !active) {
    job.historical = true;
    job.sourceStatus = imported.sourceStatus;
    job.outcome = `imported ${imported.sourceStatus}${task.error ? "; prior execution failed" : ""}`;
    if (!task.error) job.state = "done";
  }
  Object.defineProperty(job, "conversation", {
    enumerable: true, get: () => transcript(store, task) || recorded?.conversation || null,
  });
  return job;
}

function healthTable(runners) {
  return `<h2>Runner health</h2><table><thead><tr><th>Runner</th><th>Health / phase</th><th>Last successful scan</th><th>Detail</th></tr></thead><tbody>${runners.map(r =>
    `<tr><td>${escapeHtml(r.runner)}</td><td class="${r.healthy ? "ok" : "bad"}">${r.healthy ? "healthy" : "unhealthy"} / ${escapeHtml(r.phase)}</td>
    <td>${escapeHtml(r.lastScan || "not yet completed")}</td><td>${escapeHtml(r.lastError || r.healthReason || r.holding || "")}</td></tr>`
  ).join("")}</tbody></table>`;
}

export function createSpoolDashboard({ store, root, names, health, baseUrl = "http://127.0.0.1:8261", metrics = readAdoMetrics }) {
  const fleetLoader = createFleetDashboardLoader();
  const updaterDirs = names.filter(name => name === "pr-updater" || name === "pr-updater-2")
    .map(name => path.join(root, name));
  const directory = updaterDirs[0] || root;
  let snapshot;
  function load() {
    const runners = health();
    const registry = readJson(path.join(store.records, "ownership.json"));
    const imported = new Map((registry?.tasks || []).map(task => [task.taskId, task]));
    const fleet = updaterDirs.length ? fleetLoader(directory, { runnerDirs: updaterDirs })
      : { status: { pullRequests: [], open: 0, actionable: 0 }, jobs: [], actions: [], revision: 0 };
    // Reviewer diagnostics and updater ownership are different data sets.
    const status = { ...fleet.status, pullRequests: fleet.status.pullRequests.filter(pr => pr.eligible !== false && pr.queueState !== "ignored") };
    status.open = status.pullRequests.length;
    const owners = creatorBindings(store, registry);
    status.execution = owners.length ? { updatedAt: new Date().toISOString(), creators: Object.fromEntries(owners.map(owner =>
      [String(owner.prId), { verified: owner.verified, agentName: owner.creatorName, agentId: owner.sourceAgentId || owner.agent,
        sessionId: owner.sessionId || owner.continuity?.sessionId || null,
        issueId: owner.taskId, identifier: owner.taskId,
        issueUrl: owner.originKind === "copilot_cli" && !store.task(owner.taskId)
          ? null : `${baseUrl}/job?id=${encodeURIComponent(`spool:${owner.taskId}`)}` }])) } : null;
    if (registry) status.historyLabel = "current creator revisions";
    status.runners = fleet.status.runners?.map(runner => {
      const current = runners.find(r => r.runner === runner.directory);
      return { ...runner, health: current?.healthy ? runner.dataErrors.length ? "incomplete" : "healthy" : runner.health,
        statusError: current?.healthReason || current?.lastError || runner.statusError };
    });
    const tasks = store.tasks();
    const paused = store.pausedAgents();
    const live = new Set(store.liveTasks(tasks).map(task => task.id));
    const jobs = new Map(fleet.jobs.map(job => [job.jobId, job]));
    for (const [id, job] of jobs) {
      const current = runners.find(r => r.healthy && r.preparation?.prId != null && String(r.preparation.prId) === String(job.prId));
      if (current && ["queued", "preparing", "in_progress"].includes(job.state)) {
        jobs.set(id, { ...job, ownerConfirmed: true, workspace: current.preparation.repoRoot });
      }
    }
    for (const task of tasks) {
      const metadata = store.metadata(task.id);
      const recorded = metadata?.key ? jobs.get(metadata.key) : null;
      const job = taskJob(store, task, recorded, metadata, live.has(task.id), baseUrl, imported.get(task.id));
      jobs.set(job.jobId, job);
      const creator = status.execution?.creators?.[String(metadata?.prId)];
      if (creator) creator.issueUrl = job.issueUrl;
    }
    const allJobs = [...jobs.values()].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    const currentJobs = registry ? allJobs.filter(job => job.creatorRevision || job.jobId.startsWith("spool-creator:")) : allJobs;
    const currentIds = new Set(currentJobs.map(job => job.jobId));
    const historicalCounts = {};
    for (const task of imported.values()) historicalCounts[task.sourceStatus] = (historicalCounts[task.sourceStatus] || 0) + 1;
    const priorFailures = registry ? allJobs.filter(job => !currentIds.has(job.jobId) && (job.error || job.state === "failed")).length : 0;
    const archiveHtml = registry ? `<h2>Imported history, not current executions</h2>
      <p>${imported.size} original work items restored. Original snapshot: ${Object.entries(historicalCounts).map(([state, count]) => `${count} ${escapeHtml(state)}`).join("; ")}.</p>
      <p>${priorFailures} prior preparation/execution failures remain in the history with their errors. Cancelled imports are shown as cancelled, not failed executions.
      Current creator revisions are counted separately above; task completion alone is not verified PR success.</p>` : "";
    const history = [
      ...allJobs.filter(job => ["done", "failed", "blocked"].includes(job.state)).map(job => ({ at: job.doneAt || job.at, job })),
      ...fleet.actions.map(action => ({ at: action.at, action })),
    ].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    const active = allJobs.filter(job => !["done", "failed", "blocked"].includes(job.state));
    const activeHtml = `<h2>In-flight &amp; queued Spool work</h2>${active.length ? `<table><thead><tr><th>Agent</th><th>Task / setup</th><th>State</th><th>Workspace</th></tr></thead><tbody>${active.map(job =>
      `<tr><td>${escapeHtml(job.agent || "")}</td><td><a href="/job?id=${encodeURIComponent(job.jobId)}">${escapeHtml(job.taskId || job.jobId)}</a></td><td>${escapeHtml(job.state)}</td><td>${escapeHtml(job.workspace || "See setup details")}</td></tr>`
    ).join("")}</tbody></table>` : '<p class="empty">No active or queued work.</p>'}`;
    snapshot = {
      healthy: runners.length === names.length && runners.every(r => r.healthy),
      error: null, runners, active_prs: status.open,
      paused_agents: paused,
      in_progress: tasks.filter(t => t.status === "in_progress").length,
      incoming: tasks.filter(t => t.status === "incoming").length,
      recent: tasks.filter(t => ["completed", "failed"].includes(t.status)).length,
    };
    return { ...fleet, status, jobs: allJobs, history, summary: summarize(currentJobs), now: Date.now(),
      extraSummary: `<p><a href="/agents">Agent conversations</a></p>${paused.length ? `<p>Paused agents: ${paused.map(escapeHtml).join(", ")}. Existing executions may finish; new work is held.</p>` : ""}${healthTable(runners)}${activeHtml}${archiveHtml}<p><a href="/ado.json">Local ADO usage</a> · <a href="/api/status">Runner health JSON</a></p>` };
  }
  const original = createDashboardHandler(directory, { load, metrics });
  const agentDashboard = createAgentDashboard(store);
  return async (request, response) => {
    if (await agentDashboard(request, response)) return;
    if (new URL(request.url, baseUrl).pathname !== "/api/status") return original(request, response);
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { allow: "GET, HEAD" }); response.end(); return;
    }
    let result;
    try { load(); result = snapshot; }
    catch (error) { result = { healthy: false, error: error.message, runners: health() }; }
    response.writeHead(result.healthy ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(request.method === "HEAD" ? "" : JSON.stringify(result));
  };
}
