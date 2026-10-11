/**
 * The telemetry dashboard: one page that answers whether this thing is working.
 *
 * Three questions, in the order a person asks them. Are pull requests reaching the queue, is
 * anything running right now, and what happened before. The third is the one that was missing
 * during every outage so far, so history is not a summary: each finished run opens to its full
 * timings and the agent's own transcript.
 *
 * Server-rendered with no framework. Refreshes and lazy details read local telemetry only;
 * ordinary links keep history and full diagnostics accessible without JavaScript.
 *
 * No regular expressions are used.
 */
import fs from "node:fs";
import path from "node:path";
import { escapeHtml, duration, when, stepsCell, STYLES } from "./dashboard-parts.mjs";
import { owners } from "./ownership.mjs";
import { readJobs, summarize } from "./telemetry.mjs";
import { readActions } from "./activity.mjs";

const TERMINAL = ["done", "failed", "blocked"];

/** The badge that says who holds a row, in words as well as colour. */
function ownerBadge(owned) {
  if (!owned) return "";
  const elapsed = Number.isFinite(owned.elapsedMs) ? ` ${duration(owned.elapsedMs)}` : "";
  const label = owned.actor === "agent" ? "agent working" : `script ${owned.state}`;
  return `<span class="own own-${escapeHtml(owned.actor)}">${escapeHtml(label)}${escapeHtml(elapsed)}</span>`;
}

function executionLinks(job, runLabel = "Run history") {
  return `${job.issueUrl ? ` <a href="${safeUrl(job.issueUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(job.identifier || "Paperclip work item")}</a>` : ""}
    ${job.runUrl ? ` <a href="${safeUrl(job.runUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(runLabel)}</a>` : ""}`;
}

function attributionCell(holder, creator) {
  const origin = creator?.verified ? `${escapeHtml(creator.agentName)}${executionLinks(creator, "Creation run")}`
    : '<span class="muted">Creator unverified</span>';
  if (!holder) return origin;
  const sameOrigin = creator?.verified && holder.agentId === creator.agentId && holder.issueId === creator.issueId;
  return `${escapeHtml(holder.agentName || holder.agent || "Worker unknown")}${executionLinks(holder)}
    ${sameOrigin ? "" : `<div class="muted">${creator?.verified ? "Created by: " : ""}${origin}</div>`}`;
}

function prCell(job) {
  const label = escapeHtml(job.prId || "");
  return job.prUrl ? `<a href="${safeUrl(job.prUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return escapeHtml(url.href);
  } catch {}
  return "#";
}

function tag(trigger) {
  if (!trigger) return "";
  return `<span class="tag t-${escapeHtml(trigger)}">${escapeHtml(trigger)}</span>`;
}

function approvalsCell(pr) {
  const approvals = pr.approvals ?? 0;
  const reviewers = pr.reviewers;
  const hasReviewers = typeof reviewers === "number" && reviewers > 0;
  if (pr.approvalLabel && pr.approvalLabel.includes("blocking")) {
    return hasReviewers ? `${approvals}/${reviewers} (${pr.approvalLabel})` : pr.approvalLabel;
  }
  if (hasReviewers) {
    return `${approvals}/${reviewers}`;
  }
  return pr.approvalLabel ?? String(approvals);
}

/** Watched pull requests, with build health, who holds each row, and an explicit merge-ready call. */
function watchTable(status, owned) {
  const rows = status?.pullRequests || [];
  if (rows.length === 0) return '<p class="empty">No active pull requests.</p>';
  const body = rows
    .map((pr) => {
      const build = pr.build || { state: "none", label: "no builds" };
      const holder = owned.get(String(pr.id));
      const creator = status.execution?.creators?.[String(pr.id)];
      const unresolvedClass = pr.unresolvedHuman > 0 ? "warn" : "muted";
      const unresolved = pr.unresolvedHuman > 0
        ? `${pr.unresolved} (${pr.unresolvedHuman} human)`
        : String(pr.unresolved ?? 0);
      const rowClass = [holder ? `held held-${holder.actor}` : "", pr.ready && !holder ? "ready" : ""]
        .filter(Boolean)
        .join(" ");
      return `<tr class="${rowClass}">
        <td><a href="${safeUrl(pr.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(pr.id)}</a></td>
        <td>${escapeHtml(pr.title)}</td>
        <td class="b-${escapeHtml(build.state)}">${escapeHtml(build.label)}</td>
        <td class="num">${escapeHtml(approvalsCell(pr))}</td>
        <td class="num ${unresolvedClass}">${escapeHtml(unresolved)}</td>
        <td>${attributionCell(holder, creator)}</td>
        <td>${ownerBadge(holder)}${holder ? "" : pr.ready ? '<span class="ready-flag">ready to merge</span>' : `${tag(pr.trigger)} <span class="muted">${escapeHtml(pr.dispatchHold || pr.reason || "")}</span>`}</td>
      </tr>`;
    })
    .join("");
  return `<table><thead><tr><th>PR</th><th>Title</th><th>Build</th><th>Approvals</th>
    <th>Unresolved</th><th>Agent / work item</th><th>Status</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** The timings that separate a slow job from a stuck one. */
function metrics(job) {
  const total = Number.isFinite(job.setupMs) && Number.isFinite(job.agentMs) ? job.setupMs + job.agentMs : null;
  const cells = [
    ["queued", when(job.queuedAt || job.at)],
    ["repo setup", duration(job.setupMs)],
    ["agent work", duration(job.agentMs)],
    ["pr update", duration(job.updateMs)],
    ["total", duration(total)],
    ["finished", when(job.doneAt || job.at)],
    ["outcome", job.outcome || job.state],
    ["workspace", job.workspace],
    ["session", job.sessionId],
    ["turns", job.turns == null ? null : String(job.turns)],
    ["cost (USD)", job.costUsd == null ? null : String(job.costUsd)],
  ];
  return `<div class="metrics">${cells
    .filter(([, value]) => value)
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span>${escapeHtml(value)}</div>`)
    .join("")}</div>`;
}

/**
 * One finished run, as a row in the activity log that opens on demand.
 *
 * The transcript is included in full rather than truncated. It is the only account of what the
 * agent actually did with the pull request, and a clipped one has already cost a diagnosis, so it
 * is disclosed rather than dropped.
 */
function jobEntry(job, lazy = false) {
  const failed = job.state === "failed" || ["blocked", "failed", "cancelled", "timed_out", "expired"].includes(job.outcome);
  const headline = job.state === "blocked" ? "preparation blocked" : job.historical && !job.error ? job.outcome : failed ? `failed during ${job.phase || "run"}` : job.outcome || "done";
  // A job that never reached the harness was the script's work, not the agent's. Agent time, or a
  // dispatch record, is the proof it got there; a prepare failure has neither.
  const actor = job.dispatchedAt || Number.isFinite(job.agentMs) ? "agent" : "script";
  const url = `/job?id=${encodeURIComponent(job.jobId)}`;
  return `<details class="ev"${lazy ? ` data-job-url="${escapeHtml(url)}"` : ""}>
    <summary>
      <span class="ago">${escapeHtml(when(job.doneAt || job.at))}</span>
      <span class="who who-${actor}">${actor}</span>
      <span>${escapeHtml(job.agentName || job.agent || "")}${executionLinks(job)}</span>
      <strong>${prCell(job)}</strong>
      <span class="${job.state === "blocked" || job.historical && !job.error ? "muted" : failed ? "bad" : "ok"}">${escapeHtml(headline)}</span>
      ${tag(job.trigger)}
      <span class="muted">${escapeHtml(job.reason || "")}</span>
    </summary>
    ${lazy ? `<p data-job-error class="bad" role="status"></p><div data-job-detail><a href="${escapeHtml(url)}">Open full timings, errors and transcript</a></div>` : renderJobDetail(job)}
  </details>`;
}

export function renderJobDetail(job) {
  const log = [job.error, job.detail, job.conversation].filter(Boolean).join("\n\n");
  return `${executionLinks(job)}${metrics(job)}<div class="metrics">${stepsCell(job.steps)}</div>
    ${(job.runs || []).map((run) => `<article class="ev">
      <a href="${safeUrl(run.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(run.agentName || run.agentId)}: ${escapeHtml(run.status)} — ${escapeHtml(when(run.startedAt))}</a>
      <p>Session: ${escapeHtml(run.continuity?.mode || (run.sessionIdAfter ? "recorded" : "not persisted"))};
      before <code>${escapeHtml(run.sessionIdBefore || "none")}</code>;
      after <code>${escapeHtml(run.sessionIdAfter || "none")}</code>.</p>
      ${run.summary || run.error ? `<pre class="log">${escapeHtml([run.error, run.summary].filter(Boolean).join("\n\n"))}</pre>` : ""}
    </article>`).join("")}
    ${log ? `<pre class="log">${escapeHtml(log)}</pre>` : '<p class="empty">No transcript recorded.</p>'}`;
}

/** Work the script did on its own, which never becomes a job and is otherwise invisible. */
function actionEntry(action, lazy = false) {
  const repeats = action.count > 1 ? ` <span class="repeat">&times;${escapeHtml(action.count)}</span>` : "";
  const detail = String(action.detail || "");
  const text = lazy && detail.length > 300 ? `${escapeHtml(detail.slice(0, 300))}… <a href="/jobs.json">Full action in raw data</a>` : escapeHtml(detail);
  return `<div class="ev flat ${action.failed ? "s-failed" : ""}">
    <span class="ago">${escapeHtml(when(action.at))}</span>
    <span class="who who-script">script</span>
    <strong>${escapeHtml(action.prId || "")}</strong>
    <span class="${action.failed ? "bad" : "muted"}">${text}</span>${repeats}
  </div>`;
}

/**
 * Finished runs and script actions as one newest-first log.
 *
 * They were two sections, which forced the reader to interleave two clocks by hand to reconstruct
 * a single sequence of events. They are the same kind of thing, something that happened to a pull
 * request, so they share one list and differ only by who did it and whether there is more to open.
 */
function activityLog(jobs, actions) {
  const entries = [
    ...jobs.filter((job) => TERMINAL.includes(job.state)).map((job) => ({ at: job.doneAt || job.at, html: jobEntry(job) })),
    ...(actions || []).map((action) => ({ at: action.at, html: actionEntry(action) })),
  ].sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")));
  if (entries.length === 0) return '<p class="empty">Nothing has happened yet.</p>';
  return entries.map((entry) => entry.html).join("");
}

function headline(status, summary, now = Date.now()) {
  if (!status) return '<p class="headline bad">No status file yet. The runner has not completed a pass.</p>';
  const stalled = summary.stalled > 0 ? ` <span class="bad">${summary.stalled} stalled</span>` : "";
  // Why nothing is being handed over matters as much as the counts: a runner holding because the
  // agent is mid-turn looks identical to a broken one unless it says so.
  const holding = status.holding
    ? ` <span class="holding">Holding: ${escapeHtml(status.holding)}.</span>`
    : "";
  const fleetInfo = status.runnerNames
    ? ` across runners (<strong>${escapeHtml(status.runnerNames)}</strong>)`
    : "";
  const execution = status.execution;
  const executionWarning = execution && (execution.error || now - timestamp(execution.updatedAt) > 120_000)
    ? `<span class="bad">Paperclip activity is unconfirmed: ${escapeHtml(execution.error || "snapshot is stale")}. </span>` : "";
  return `${outageBanner(status)}${runnerFreshness(status)}<p class="headline">${executionWarning}Watching <strong>${escapeHtml(status.open ?? 0)}</strong> pull requests${fleetInfo},
    <strong>${escapeHtml(status.actionable ?? 0)}</strong> actionable.
    ${escapeHtml(summary.running)} running; ${escapeHtml(status.historyLabel || "recorded history")}: ${escapeHtml(summary.done)} done,
    <span class="${summary.failed > 0 ? "bad" : ""}">${escapeHtml(summary.failed)} failed</span>${summary.blocked ? `; ${escapeHtml(summary.blocked)} blocked` : ""}${stalled}.
    ${status.runners ? "Oldest runner pass" : "Last pass"} ${escapeHtml(when(status.lastScan) || "unknown")}.${holding}</p>`;
}

function runnerFreshness(status) {
  if (!status.runners) return "";
  return `<ul>${status.runners.map((runner) => `<li class="${runner.health === "healthy" ? "muted" : "bad"}">
    ${escapeHtml(runner.agent)}: ${escapeHtml(runner.health)}; last successful pass ${escapeHtml(when(runner.lastScan) || "unknown")}.
    ${runner.statusError ? escapeHtml(runner.statusError) : ""}
    ${runner.staleSince ? `Stale since ${escapeHtml(when(runner.staleSince))}.` : ""}
    ${runner.blocked ? outageBanner(runner) : ""}
    ${runner.dataErrors?.map(escapeHtml).join("; ") || ""}
  </li>`).join("")}</ul>`;
}

/**
 * The alarm for a runner that is up but blind.
 *
 * Placed above everything because the failure it reports is invisible otherwise: the table below
 * still lists pull requests, and they are the ones from the last pass that worked. Without this
 * banner an expired credential reads as a quiet afternoon.
 */
function outageBanner(status) {
  if (status.runners) return "";
  const blocked = status.blocked;
  if (!blocked) return "";
  const remedy = blocked.remedy
    ? `<div class="remedy">Fix with <code>${escapeHtml(blocked.remedy)}</code></div>`
    : "";
  const stale = status.staleSince ? ` Showing state from ${escapeHtml(when(status.staleSince))}.` : "";
  return `<div class="outage">
    <strong>MONITORING DOWN.</strong> ${escapeHtml(blocked.headline)}.
    Failed ${escapeHtml(blocked.cycles)} cycle(s) in a row.${stale}
    <div class="muted">${escapeHtml(blocked.error)}</div>
    ${remedy}
  </div>`;
}

/** Find all sibling pr-updater runner directories. */
export function findSiblingRunnerDirectories(currentRunnerDir) {
  const parentDir = path.dirname(currentRunnerDir);
  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && (e.name === "pr-updater" || e.name.startsWith("pr-updater-")))
      .map((e) => path.join(parentDir, e.name));
  } catch {
    return [currentRunnerDir];
  }
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function fingerprint(file) {
  try {
    const st = fs.statSync(file, { bigint: true });
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch (error) {
    return `unavailable:${error.code}`;
  }
}

/**
 * Cache parsed files independently and rebuild the fleet only when their metadata changes.
 * Full folds retain old active jobs and allow lazy access to every recorded terminal job.
 * Truncation, replacement, deletion and repaired partial writes all invalidate the same cache.
 */
export function createFleetDashboardLoader() {
  const files = new Map();
  let previousKey;
  let aggregate;
  const stats = { fileReads: 0, cacheHits: 0, aggregations: 0 };
  function read(file, signature, parse, fallback) {
    const cached = files.get(file);
    if (cached?.signature === signature) {
      stats.cacheHits += 1;
      return cached;
    }
    let value = fallback;
    let error = null;
    try {
      if (signature.startsWith("unavailable:")) throw new Error(signature.slice(12));
      stats.fileReads += 1;
      value = parse(file);
    } catch (cause) {
      error = `${path.basename(file)} unavailable: ${cause.message}`;
    }
    // Windows may update ctime on the first read. Accept that metadata-only change,
    // but leave content/identity changes invalidated so a concurrent write is reread.
    const after = fingerprint(file);
    if (signature.split(":").slice(0, -1).join(":") === after.split(":").slice(0, -1).join(":")) signature = after;
    const entry = { signature, value, error };
    files.set(file, entry);
    return entry;
  }
  function load(currentRunnerDir, options = {}) {
    const now = options.now ?? Date.now();
    const staleAfterMs = options.staleAfterMs ?? 15 * 60_000;
    const dirs = [...new Set((options.runnerDirs || findSiblingRunnerDirectories(currentRunnerDir)).map((dir) => path.resolve(dir)))].sort();
    if (!dirs.length) dirs.push(path.resolve(currentRunnerDir));
    const snapshots = dirs.map((dir) => ({
      dir,
      files: ["status.json", "jobs.jsonl", "activity.jsonl", "paperclip-execution.json"].map((name) => {
        const file = path.join(dir, ".runner", name);
        return { file, signature: fingerprint(file) };
      }),
    }));
    const key = JSON.stringify(snapshots);
    if (key !== previousKey) {
      stats.aggregations += 1;
      const runners = [];
      const prMap = new Map();
      const dispatchHolds = new Map();
      const jobMap = new Map();
      const actions = [];
      let ado = [];
      let adoAt = null;
      let execution = null;
      const usedFiles = new Set();
      for (const snapshot of snapshots) {
        const [statusFile, jobsFile, actionsFile, executionFile] = snapshot.files;
        const executionEntry = read(executionFile.file, executionFile.signature, (file) => JSON.parse(fs.readFileSync(file, "utf8")), null);
        executionFile.signature = executionEntry.signature;
        if (executionEntry.value && (!execution || timestamp(executionEntry.value.updatedAt) > timestamp(execution.updatedAt))) execution = executionEntry.value;
        for (const { file } of snapshot.files) usedFiles.add(file);
        const statusEntry = read(statusFile.file, statusFile.signature, (file) => {
          const value = JSON.parse(fs.readFileSync(file, "utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value) ||
              (value.pullRequests != null && !Array.isArray(value.pullRequests))) throw new Error("invalid status");
          return value;
        }, null);
        const jobsEntry = read(jobsFile.file, jobsFile.signature, (file) => readJobs(file, Infinity), []);
        const actionsEntry = read(actionsFile.file, actionsFile.signature, (file) => readActions(file, Infinity), []);
        statusFile.signature = statusEntry.signature;
        jobsFile.signature = jobsEntry.signature;
        actionsFile.signature = actionsEntry.signature;
        const st = statusEntry.value || {};
        // Each runner records the same fleet-global transport counters. Choose one
        // latest snapshot rather than multiplying usage by the number of runners.
        if (Array.isArray(st.ado) && (adoAt == null || timestamp(st.lastScan) > timestamp(adoAt))) {
          ado = st.ado;
          adoAt = st.lastScan || null;
        }
        const runner = {
          directory: path.basename(snapshot.dir), agent: st.agent || path.basename(snapshot.dir),
          pid: st.pid, holding: st.holding, lastScan: timestamp(st.lastScan) ? st.lastScan : null,
          lastSurvey: timestamp(st.lastSurvey) ? st.lastSurvey : st.lastScan,
          blocked: st.blocked || null, staleSince: st.staleSince || null,
          statusAvailable: !!statusEntry.value, statusError: statusEntry.error,
          dataErrors: [jobsEntry.error, actionsEntry.error].filter(Boolean),
        };
        runners.push(runner);
        for (const pr of st.pullRequests || []) {
          if (!pr || pr.id == null) continue;
          const id = String(pr.id);
          if (pr.dispatchOwner === true && (!dispatchHolds.has(id) ||
              timestamp(runner.lastScan) > timestamp(dispatchHolds.get(id).at))) {
            dispatchHolds.set(id, { hold: pr.dispatchHold || null, actionable: pr.actionable,
              trigger: pr.trigger, reason: pr.reason, sourceCommit: pr.sourceCommit, at: runner.lastScan });
          }
          const evidence = { ...pr, evidenceAt: runner.lastSurvey, evidenceRunner: runner.agent };
          const existing = prMap.get(id);
          // Never prefer an old ready/trigger flag over a newer observation.
          if (!existing || timestamp(evidence.evidenceAt) > timestamp(existing.evidenceAt)) prMap.set(id, evidence);
        }
        for (const job of jobsEntry.value) {
          const previous = jobMap.get(job.jobId);
          if (!previous || timestamp(job.at || job.doneAt) > timestamp(previous.at || previous.doneAt)) jobMap.set(job.jobId, { ...job, ...executionEntry.value?.jobs?.[job.jobId] });
        }
        for (const job of Object.values(executionEntry.value?.relatedJobs || {})) {
          const previous = jobMap.get(job.jobId);
          if (!previous || timestamp(job.at) > timestamp(previous.at)) jobMap.set(job.jobId, job);
        }
        actions.push(...actionsEntry.value);
      }
      for (const file of files.keys()) if (!usedFiles.has(file)) files.delete(file);
      const dispatchedRuns = new Set([...jobMap.values()]
        .filter((job) => !job.jobId.startsWith("paperclip:"))
        .flatMap((job) => (job.runs || []).map((run) => `${job.prId}:${run.id}`)));
      for (const [id, job] of jobMap) {
        if (id.startsWith("paperclip:") && dispatchedRuns.has(`${job.prId}:${job.runId}`)) jobMap.delete(id);
      }
      const jobs = [...jobMap.values()].sort((a, b) => timestamp(b.at || b.doneAt) - timestamp(a.at || a.doneAt));
      actions.sort((a, b) => timestamp(b.at) - timestamp(a.at));
      const history = [
        ...jobs.filter((job) => TERMINAL.includes(job.state)).map((job) => ({ at: job.doneAt || job.at, job })),
        ...actions.map((action) => ({ at: action.at, action })),
      ].sort((a, b) => timestamp(b.at) - timestamp(a.at));
      aggregate = { runners, jobs, actions, history, ado, adoAt, execution,
        pullRequests: [...prMap.values()].map(pr => {
          const owner = dispatchHolds.get(String(pr.id));
          if (owner && pr.sourceCommit && owner.sourceCommit !== pr.sourceCommit) {
            const reason = "Awaiting owning lane survey of current PR revision";
            return { ...pr, trigger: null, actionable: false, reason, dispatchHold: reason };
          }
          return { ...pr, dispatchHold: owner?.hold || null,
            trigger: owner ? owner.trigger : pr.trigger,
            reason: owner ? owner.reason : pr.reason,
            actionable: owner?.actionable ?? pr.actionable };
        }).sort((a, b) => Number(b.id) - Number(a.id)) };
      previousKey = JSON.stringify(snapshots);
    }
    const runners = aggregate.runners.map((runner) => ({
      ...runner,
      health: runner.blocked ? "blocked" : !runner.statusAvailable || !runner.lastScan ? "unknown"
        : now - timestamp(runner.lastScan) > staleAfterMs ? "stale" : runner.dataErrors.length ? "incomplete" : "healthy",
    }));
    const scans = runners.map((runner) => runner.lastScan).filter(Boolean).sort((a, b) => timestamp(a) - timestamp(b));
    const blocked = runners.filter((runner) => runner.blocked);
    const stale = runners.map((runner) => runner.staleSince).filter(Boolean).sort((a, b) => timestamp(a) - timestamp(b));
    const status = {
      mode: "updater-fleet", runners, runnerNames: runners.map((runner) => runner.agent).join(", "),
      execution: aggregate.execution,
      ado: aggregate.ado, adoAt: aggregate.adoAt,
      health: runners.every((runner) => runner.health === "healthy") ? "healthy" : "degraded",
      lastScan: scans.length === runners.length ? scans[0] : null,
      latestScan: scans.at(-1) || null, staleSince: stale[0] || null,
      blocked: blocked.length ? { kind: "fleet", headline: `${blocked.length} runner(s) cannot monitor`, runners: blocked.map((runner) => runner.agent) } : null,
      holding: runners.filter((runner) => runner.holding).map((runner) => `${runner.agent}: ${runner.holding}`).join(" | ") || null,
      open: aggregate.pullRequests.length,
      actionable: aggregate.pullRequests.filter((pr) => pr.actionable ?? (pr.trigger != null)).length,
      pullRequests: aggregate.pullRequests,
    };
    return { status, jobs: aggregate.jobs, actions: aggregate.actions, history: aggregate.history,
      summary: summarize(aggregate.jobs, now), now, revision: stats.aggregations };
  }
  load.stats = stats;
  return load;
}

export const loadFleetDashboardData = createFleetDashboardLoader();

export function renderAdoMetrics(scopes = [], snapshotAt = null) {
  const reports = Array.isArray(scopes) ? scopes.filter((scope) => scope && typeof scope === "object") : [];
  const source = snapshotAt ? `Status snapshot from ${escapeHtml(when(snapshotAt) || "unknown")}.` : "Read from local shared transport files.";
  const link = '<a href="/ado.json">Full local ADO metrics</a>';
  if (!reports.length) return `<p class="empty">ADO usage metrics unavailable; no counters recorded. ${link}</p>`;
  const number = (value) => Number.isFinite(value) && value >= 0 ? escapeHtml(value) : "unknown";
  return `<p>${source} Shared counters are listed once per scope, not summed across runners. ${link}</p>
    <table><thead><tr><th>Scope</th><th>Network requests</th><th>Cache hits / misses</th><th>Errors / throttles</th>
    <th>Auth refreshes</th><th>Response bytes</th><th>Request time</th><th>Updated</th></tr></thead><tbody>
    ${reports.map((scope) => `<tr><td title="${escapeHtml(scope.scope)}">${escapeHtml(String(scope.scope || "unknown").slice(0, 12))}</td>
      <td>${number(scope.networkRequests)}</td><td>${number(scope.cacheHits)} / ${number(scope.cacheMisses)}</td>
      <td>${number(scope.errors)} / ${number(scope.throttles)}</td><td>${number(scope.authRefreshes)}</td>
      <td>${number(scope.responseBytes)}</td><td>${escapeHtml(duration(scope.durationMs) || "unknown")}</td>
      <td>${escapeHtml(when(scope.updatedAt) || "unknown")}</td></tr>`).join("")}</tbody></table>
    <p class="muted">Cumulative since ${escapeHtml(reports.map((scope) => when(scope.startedAt) || "unknown").join(", "))}.
    Cache hits are reused reads, not a measurement of remaining TSTU quota or agent/Git traffic.</p>`;
}

export function renderSummary({ status, jobs = [], summary = summarize(jobs), now = Date.now(), extraSummary = "" }) {
  return `${headline(status, summary, now)}
    <h2>Watched pull requests</h2>${watchTable(status, owners(jobs, now))}${extraSummary}`;
}

export function renderHistory(fleet, offset = 0, limit = 20) {
  const history = fleet.history || [
    ...fleet.jobs.filter((job) => TERMINAL.includes(job.state)).map((job) => ({ at: job.doneAt || job.at, job })),
    ...(fleet.actions || []).map((action) => ({ at: action.at, action })),
  ].sort((a, b) => timestamp(b.at) - timestamp(a.at));
  const entries = history.slice(offset, offset + limit);
  const html = entries.map((entry) => entry.job ? jobEntry(entry.job, true) : actionEntry(entry.action, true)).join("");
  const next = offset + entries.length < history.length ? offset + entries.length : null;
  return `${html || '<p class="empty">Nothing has happened yet.</p>'}
    <nav><a href="/history?offset=0">Latest history</a>${offset ? ' · <a href="/history?offset=0">Back to newest</a>' : ""}
    ${next != null ? ` · <a href="/history?offset=${next}">Older history</a>` : ""}</nav>`;
}

export function renderDocument(body, script = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PR agent activity</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>${STYLES}</style></head><body><h1>PR agent activity</h1>${body}${script}</body></html>`;
}

function refreshScript(refreshSeconds) {
  return `<script>
    document.addEventListener("toggle", async (event) => {
      const entry = event.target;
      if (!entry.open || !entry.dataset.jobUrl || entry.dataset.loaded) return;
      entry.dataset.loaded = "loading";
      const status = entry.querySelector("[data-job-error]");
      status.textContent = "Loading details...";
      try {
        const response = await fetch(entry.dataset.jobUrl + "&fragment=1", { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error("Details unavailable");
        entry.querySelector("[data-job-detail]").innerHTML = await response.text();
        entry.dataset.loaded = "done";
        status.textContent = "";
      } catch {
        delete entry.dataset.loaded;
        status.textContent = "Details unavailable; close and reopen to retry, or use the full details link.";
      }
    }, true);
    async function refresh() {
      try {
        const response = await fetch("/summary.json", { cache: "no-store", signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error("Refresh failed");
        const data = await response.json();
        if (typeof data.html !== "string") throw new Error("Invalid summary");
        document.getElementById("live").innerHTML = data.html;
        document.getElementById("refresh-state").textContent = "";
      } catch { document.getElementById("refresh-state").textContent = "Refresh failed; displayed data may be stale."; }
      setTimeout(refresh, ${Math.max(1, Number(refreshSeconds) || 30) * 1000});
    }
    if (document.getElementById("live")) {
      setTimeout(refresh, ${Math.max(1, Number(refreshSeconds) || 30) * 1000});
    }
  </script>`;
}

export function renderDashboard({ refreshSeconds = 30, lazy = true, ...fleet }) {
  return renderDocument(`<section id="live">${renderSummary(fleet)}</section>
    <p id="refresh-state" class="bad" role="status"></p>
    <h2>Activity</h2>${lazy ? renderHistory(fleet) : activityLog(fleet.jobs || [], fleet.actions || [])}
    <footer>Summary refreshes every ${escapeHtml(refreshSeconds)}s; history loads on demand.
    <a href="/">Refresh page</a>. Raw data at <a href="/jobs.json">/jobs.json</a>.</footer>
    <noscript>Automatic refresh needs JavaScript; use Refresh page and the history/detail links.</noscript>`, refreshScript(refreshSeconds));
}

export function renderHistoryPage(fleet, offset) {
  return renderDocument(`<a href="/">Dashboard</a><h2>Activity</h2>${renderHistory(fleet, offset)}`, refreshScript(30));
}
