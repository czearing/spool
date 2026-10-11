import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { readJobs } from "../pr-updater/lib/telemetry.mjs";
import { writeJsonAtomic } from "../pr-updater/lib/state.mjs";
import { resolveProvenance } from "./pr-provenance.mjs";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "expired"]);
async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

export function issueLink(base, identifier) {
  if (!identifier || !/^[A-Za-z0-9]+-\d+$/.test(identifier)) return null;
  return `${base.replace(/\/$/, "")}/${identifier.split("-")[0]}/issues/${identifier}`;
}

export function linkJob(job, mapping, issue, runs, agents, base, nextDispatch = Infinity) {
  const start = Date.parse(job.dispatchedAt || mapping?.at || "");
  const finished = Date.parse(job.doneAt || "");
  const matches = Number.isFinite(start)
    ? runs.filter((run) => Date.parse(run.startedAt) >= start - 5000 && Date.parse(run.startedAt) < nextDispatch - 5000 &&
      (!Number.isFinite(finished) || Date.parse(run.startedAt) <= finished))
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    : [];
  const latest = matches.at(-1);
  const agentId = latest?.agentId || job.agentId;
  const identifier = issue?.identifier || job.identifier || mapping?.identifier;
  const prefix = identifier?.split("-")[0];
  const runUrl = (run) => prefix ? `${base.replace(/\/$/, "")}/${prefix}/agents/${run.agentId}/runs/${run.id}` : null;
  return {
    issueId: issue?.id || job.issueId || mapping?.issueId,
    identifier, issueUrl: issueLink(base, identifier),
    agentId, agentName: agents.find((agent) => agent.id === agentId)?.name || job.agent,
    issueStatus: issue?.status, runId: latest?.id, runUrl: latest && runUrl(latest),
    runStatus: latest?.status,
    runs: matches.map((run) => ({ ...run, url: runUrl(run), agentName: agents.find((agent) => agent.id === run.agentId)?.name || run.agentId })),
  };
}

export async function discoverRelatedIssues(creators, liveRuns, api, previous = {}) {
  const related = { ...previous };
  const origins = new Map(Object.values(creators).filter((creator) => creator.issueId).map((creator) => [creator.issueId, creator]));
  const issues = new Map();
  const getIssue = async (id) => {
    if (!issues.has(id)) issues.set(id, await api(`/issues/${id}`));
    return issues.get(id);
  };
  const workspace = (issue) => issue.executionWorkspaceId
    ? `execution:${issue.executionWorkspaceId}` : issue.projectWorkspaceId ? `project:${issue.projectWorkspaceId}` : null;
  for (const run of liveRuns) {
    const issueId = run.contextSnapshot?.issueId;
    if (!issueId || !Number.isFinite(Date.parse(run.startedAt))) continue;
    const issue = await getIssue(issueId);
    let ancestor = issue;
    const visited = new Set();
    while (ancestor && visited.size < 16 && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);
      const creator = origins.get(ancestor.id);
      if (creator) {
        if (run.companyId === creator.companyId && issue.companyId === creator.companyId &&
            (issue.id === ancestor.id || (workspace(issue) && workspace(issue) === workspace(ancestor)))) {
          const prior = related[issueId];
          related[issueId] = {
            prId: creator.prId, prUrl: creator.prUrl, originIssueId: creator.issueId,
            since: prior?.originIssueId === creator.issueId && Date.parse(prior.since) < Date.parse(run.startedAt)
              ? prior.since : run.startedAt,
          };
        }
        break;
      }
      ancestor = ancestor.parentId ? await getIssue(ancestor.parentId) : null;
    }
  }
  return related;
}

export async function refreshExecutionSnapshot(directory, fetchImpl = fetch) {
  const file = path.join(directory, ".runner", "paperclip-execution.json");
  const previous = await readJson(file, { jobs: {}, runs: {} });
  try {
    const config = await readJson(path.join(directory, "config.json"));
    const base = config.paperclipUiUrl || config.paperclipApiUrl;
    const api = async (route) => {
      const response = await fetchImpl(`${config.paperclipApiUrl}/api${route}`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Paperclip ${route}: HTTP ${response.status}`);
      return response.json();
    };
    const [agents, live, work] = await Promise.all([
      api(`/companies/${config.paperclipCompanyId}/agents`),
      api(`/companies/${config.paperclipCompanyId}/live-runs?limit=100&minCount=0`),
      api(`/companies/${config.paperclipCompanyId}/issues?status=todo,in_progress,in_review,blocked`),
    ]);
    if (![agents, live, work].every(Array.isArray)) throw new Error("Invalid Paperclip fleet response");
    const registry = await readJson(config.creatorProvenanceFile || path.join(directory, "..", "pr-creator-provenance.json"), { version: 1, records: [] });
    if (config.creatorStateDirectory) {
      let records = [];
      try { records = await readdir(config.creatorStateDirectory); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      for (const name of records.filter((entry) => entry.endsWith(".json"))) {
        const record = await readJson(path.join(config.creatorStateDirectory, name), null);
        if (!record?.creationRunId || record.companyId !== config.paperclipCompanyId ||
            registry.records.some((entry) => entry.companyId === record.companyId && entry.prId === record.prId)) continue;
        registry.records.push({
          prId: record.prId, prUrl: record.url, companyId: record.companyId, branch: record.branch,
          issueId: record.issueId, identifier: record.identifier, agentId: record.agentId,
          creationRunId: record.creationRunId, verifiedAt: record.at,
          evidence: "Original company/issue/run verified by the feedback dispatcher from exact PR provenance.",
        });
      }
    }
    let creators = {};
    let provenanceError = null;
    try {
      creators = await resolveProvenance(registry, { config, api, agents, previous: previous.creators });
    } catch (error) {
      provenanceError = error.message;
    }
    const liveDetails = Object.fromEntries(await Promise.all(live.map(async (row) => {
      const run = await api(`/heartbeat-runs/${row.id}`);
      return [run.id, run];
    })));
    const relatedIssues = await discoverRelatedIssues(creators, Object.values(liveDetails), api, previous.relatedIssues);
    const jobs = readJobs(path.join(directory, ".runner", "jobs.jsonl"), Infinity);
    const mappings = await readJson(path.join(directory, ".runner", "paperclip-jobs.json"), {});
    const issueIds = [...new Set([
      ...jobs.map((job) => job.issueId || mappings[job.submissionId]?.issueId).filter(Boolean),
      ...Object.keys(relatedIssues),
    ])];
    const issues = {};
    const runCache = { ...previous.runs };
    // Only new or live runs need full detail; completed histories remain in the snapshot.
    for (const issueId of issueIds) {
      const [issue, runs] = await Promise.all([api(`/issues/${issueId}`), api(`/issues/${issueId}/runs`)]);
      issues[issueId] = { id: issue.id, identifier: issue.identifier, status: issue.status };
      for (const row of runs) {
        const id = row.runId || row.id;
        if (!id || (runCache[id] && TERMINAL.has(runCache[id].status))) continue;
        const run = liveDetails[id] || await api(`/heartbeat-runs/${id}`);
        runCache[id] = {
          id, issueId, agentId: run.agentId, status: run.status,
          originIssueId: run.contextSnapshot?.issueId,
          startedAt: run.startedAt, finishedAt: run.finishedAt,
          sessionIdBefore: run.sessionIdBefore, sessionIdAfter: run.sessionIdAfter,
          continuity: run.resultJson?.sessionContinuity || null,
          summary: run.resultJson?.summary || null, error: run.error || null,
        };
      }
    }
    const linked = {};
    for (const job of jobs) {
      const mapping = mappings[job.submissionId];
      const issueId = job.issueId || mapping?.issueId;
      if (!issueId) continue;
      const later = jobs.filter((other) => other.jobId !== job.jobId &&
        (other.issueId || mappings[other.submissionId]?.issueId) === issueId &&
        Date.parse(other.dispatchedAt) > Date.parse(job.dispatchedAt));
      const next = Math.min(...later.map((other) => Date.parse(other.dispatchedAt)));
      linked[job.jobId] = linkJob(job, mapping, issues[issueId],
        Object.values(runCache).filter((run) => run.issueId === issueId), agents, base, next);
    }
    const linkedRunIds = new Set(Object.values(linked).flatMap((job) => job.runs.map((run) => run.id)));
    const relatedJobs = {};
    for (const run of Object.values(runCache)) {
      const relation = relatedIssues[run.originIssueId];
      if (!relation || linkedRunIds.has(run.id) || !Number.isFinite(Date.parse(run.startedAt)) ||
          Date.parse(run.startedAt) < Date.parse(relation.since)) continue;
      const issue = issues[run.originIssueId];
      if (!issue) continue;
      const jobId = `paperclip:${run.id}`;
      const terminal = TERMINAL.has(run.status);
      relatedJobs[jobId] = {
        jobId, prId: relation.prId, prUrl: relation.prUrl,
        state: terminal ? run.status === "succeeded" ? "done" : "failed" : "dispatched",
        at: run.finishedAt || run.startedAt, dispatchedAt: run.startedAt, doneAt: run.finishedAt,
        outcome: run.status, reason: "Origin task / workspace-linked follow-up",
        ...linkJob({ dispatchedAt: run.startedAt }, {}, issue, [run], agents, base),
      };
    }
    const runners = [];
    for (const name of ["pr-reviewer", "perf", "slop", "livesite"]) {
      const status = await readJson(path.join(directory, "..", name, ".runner", "status.json"), null);
      if (!status) continue;
      const reason = status.lastError || status.holding || status.lastWakeResult?.reason ||
        (status.openPrs >= status.maxOpenPrs ? `Open PR cap reached (${status.openPrs}/${status.maxOpenPrs})` : null) ||
        (status.ignored && !status.queued ? `${status.ignored} excluded: ${[...new Set((status.pullRequests || []).map((pr) => pr.reason).filter(Boolean))].join("; ")}` : null) ||
        (status.queued ? `${status.queued} queued` : "No ready work reported");
      runners.push({ name: status.name || name, agent: status.agent, lastScan: status.lastScan, reason });
    }
    const snapshot = {
      updatedAt: new Date().toISOString(), error: provenanceError, base, jobs: linked, runs: runCache, runners, creators,
      relatedIssues, relatedJobs,
      agents: agents.map((agent) => ({
        id: agent.id, name: agent.name, status: agent.status,
        active: live.filter((run) => run.agentId === agent.id).length,
        ready: work.filter((issue) => issue.assigneeAgentId === agent.id && issue.status === "todo").length,
        blocked: work.filter((issue) => issue.assigneeAgentId === agent.id && issue.status === "blocked").length,
        persistSession: agent.adapterConfig?.persistSession === true,
      })),
      liveCount: live.length,
    };
    await writeJsonAtomic(file, snapshot);
    return snapshot;
  } catch (error) {
    const failed = { ...previous, error: error.message, attemptedAt: new Date().toISOString() };
    await writeJsonAtomic(file, failed);
    return failed;
  }
}

export function startExecutionCollector(directory) {
  let collecting = false;
  const collect = async () => {
    if (collecting) return;
    collecting = true;
    try {
      const snapshot = await refreshExecutionSnapshot(directory);
      if (snapshot.error) console.error(`[pr-execution] ${snapshot.error}`);
    } catch (error) { console.error(`[pr-execution] Cannot preserve snapshot: ${error.message}`); }
    finally { collecting = false; }
  };
  void collect();
  const timer = setInterval(collect, 30_000);
  timer.unref();
  return timer;
}
