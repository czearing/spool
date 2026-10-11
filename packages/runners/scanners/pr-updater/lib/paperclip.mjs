/**
 * Dispatch to Paperclip instead of Cairn Harness.
 *
 * Same three seams the harness client provided, so `pipeline.mjs` and `run.mjs` do not care which
 * orchestrator is behind them: submit one job, ask whether a submitted job has finished, and ask
 * whether the agent may be given anything right now.
 *
 * Paperclip has no "message to an agent" primitive. Work is an issue assigned to an agent, and
 * assignment is what wakes it, so a submission creates an issue and remembers which issue belongs
 * to which submission id.
 *
 * No regular expressions are used.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./state.mjs";

/** Issue states that mean the agent is finished with the work, whatever the outcome was. */
const TERMINAL_ISSUE = ["done", "blocked", "cancelled", "in_review"];

/** Run states that mean no execution is in flight for an issue. */
const FINISHED_RUN = ["succeeded", "failed", "cancelled", "timed_out", "expired"];

/** Agent states that mean the agent will never pick the work up, so sending is pointless. */
const STOPPED = ["paused", "disabled", "error", "terminated", "pending_approval"];

/**
 * How long after its last run finished an issue may sit in a non terminal state before the job is
 * closed anyway.
 *
 * Paperclip retries and continues runs on its own, and an issue briefly has no active run between
 * those attempts. Closing instantly would end the job while the orchestrator was still working it,
 * so the runner waits before concluding the agent exited without reporting.
 */
const ABANDONED_GRACE_MS = 2 * 60 * 1000;

function jobMapFile(config) {
  return path.join(config.repoRootRuntime || config.runtimeDirectory, "paperclip-jobs.json");
}

async function readJobMap(config) {
  try {
    const value = JSON.parse(await readFile(jobMapFile(config), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function rememberJob(config, submissionId, issue) {
  const map = await readJobMap(config);
  map[submissionId] = {
    issueId: issue.id,
    identifier: issue.identifier || issue.issueNumber || null,
    at: new Date().toISOString(),
  };
  await writeJsonAtomic(jobMapFile(config), map);
}

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return response.json();
}

export function extractPullRequestId(submissionId, body, options = {}) {
  if (options?.pr?.id) return String(options.pr.id);
  if (options?.prId) return String(options.prId);
  const segments = String(submissionId || "").split(":");
  for (const seg of segments) {
    if (/^\d{5,8}$/.test(seg)) return seg;
  }
  const lines = String(body || "").split("\n");
  for (const line of lines) {
    const match = line.match(/(?:pullrequest\/|PR\s+|pull\s+request\s+|#)(\d{5,8})/i);
    if (match) return match[1];
  }
  return null;
}

/**
 * Search Paperclip for the original work item that opened this pull request.
 */
export async function findWorkItemForPullRequest(config, prId, options = {}, fetchImpl = fetch) {
  if (!prId) return null;
  const url = `${config.paperclipApiUrl}/api/companies/${config.paperclipCompanyId}/issues?q=${encodeURIComponent(prId)}`;
  const issues = await getJson(url, fetchImpl);
  if (!Array.isArray(issues) || issues.length === 0) return null;

  // Filter out issues that were created as updater jobs or PR review tasks
  const candidates = issues.filter((issue) => {
    if (!issue || issue.status === "cancelled") return false;
    const title = String(issue.title || "");
    if (title.startsWith("PR ") || title.includes("needs an update") || title.startsWith("Pull request update")) return false;
    if (title.startsWith("Review Azure DevOps pull request")) return false;
    return true;
  });

  if (candidates.length === 0) {
    return issues.find((issue) => issue.status !== "cancelled"
      && String(issue.title || "").startsWith(`PR ${prId} `)) || null;
  }

  // If a branch is known, check if any candidate matches the branch name
  const branch = options?.pr?.branch;
  if (branch) {
    const branchMatch = candidates.find((c) => String(c.description || "").includes(branch));
    if (branchMatch) return branchMatch;
  }

  // Prefer in_review or in_progress or todo issues
  const activeCandidate = candidates.find((c) => ["in_review", "in_progress", "todo", "blocked"].includes(c.status));
  if (activeCandidate) return activeCandidate;

  return candidates[0];
}

/**
 * Hand one pull request to the agent.
 *
 * If an existing work item for the pull request is found in Paperclip, the update task is assigned
 * directly ON that work item (with status: todo and update instructions posted as a comment),
 * preserving ticket continuity. If no work item exists, a new issue is created as a fallback.
 */
export async function preparedWorkspace(config, issue, fetchImpl) {
  if (!config.repoRoot) return {};
  const projectId = issue?.projectId || config.paperclipProjectId;
  if (!projectId) throw new Error("Prepared checkout handoff requires a Paperclip project");
  const cwd = path.normalize(config.repoRoot);
  const url = `${config.paperclipApiUrl}/api/projects/${projectId}/workspaces`;
  const workspaces = await getJson(url, fetchImpl);
  if (!Array.isArray(workspaces)) throw new Error("Paperclip returned an invalid project workspace list");
  let workspace = workspaces.find((entry) => entry.cwd && path.normalize(entry.cwd) === cwd);
  if (!workspace) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: path.basename(cwd), sourceType: "local_path", cwd, isPrimary: false }),
    });
    if (!response.ok) throw new Error(`Paperclip workspace creation failed: ${response.status} ${await response.text()}`);
    workspace = await response.json();
  }
  if (!workspace?.id || !workspace.cwd || path.normalize(workspace.cwd) !== cwd) {
    throw new Error("Paperclip did not bind the prepared checkout");
  }
  return {
    projectId,
    projectWorkspaceId: workspace.id,
    executionWorkspaceId: null,
    executionWorkspacePreference: "shared_workspace",
    executionWorkspaceSettings: { mode: "shared_workspace", workspaceStrategy: { type: "project_primary" } },
    assigneeAdapterOverrides: { useProjectWorkspace: true, adapterConfig: { cwd } },
  };
}

export async function submitAgentTask(config, agentId, body, submissionId, options = {}, fetchImpl = fetch) {
  if (typeof options === "function") {
    fetchImpl = options;
    options = {};
  }

  const prId = extractPullRequestId(submissionId, body, options);
  const workItem = await findWorkItemForPullRequest(config, prId, options, fetchImpl);
  let current = workItem;
  if (workItem?.id && config.repoRoot) {
    const url = `${config.paperclipApiUrl}/api/issues/${workItem.id}`;
    current = await getJson(url, fetchImpl);
    const runs = await getJson(`${url}/runs`, fetchImpl);
    const rows = Array.isArray(runs) ? runs : runs.runs || [];
    if (current.activeRun || rows.some((run) => !FINISHED_RUN.includes(String(run.status)))) {
      throw new Error(`Paperclip issue ${workItem.identifier || workItem.id} already has an active run`);
    }
  }
  const workspace = await preparedWorkspace(config, current, fetchImpl);

  const updateMessage = [
    "## Pull Request Update Needed",
    "",
    body,
    "",
    "---",
    `Dispatched by the pr-updater runner. Submission id: ${submissionId}`,
    "Your branch is already checked out. Do not switch, create, or reset branches.",
  ].join("\n");

  if (workItem?.id) {
    const patchUrl = `${config.paperclipApiUrl}/api/issues/${workItem.id}`;
    const patchOptions = {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assigneeAgentId: config.paperclipAgentId || agentId,
        assigneeUserId: null,
        status: "todo",
        comment: updateMessage,
        ...workspace,
      }),
    };

    let patchResponse;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        patchResponse = await fetchImpl(patchUrl, patchOptions);
        break;
      } catch (error) {
        if (attempt === 2) throw new Error(`Paperclip reassign failed after retry: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (patchResponse && patchResponse.ok) {
      const updated = await patchResponse.json();
      if (!updated?.id || !["todo", "in_progress"].includes(updated.status)) {
        throw new Error(`Paperclip did not accept dispatch: status ${updated?.status || "missing"}`);
      }
      await rememberJob(config, submissionId, updated);
      return updated;
    }
    const detail = patchResponse?.text ? await patchResponse.text() : "";
    throw new Error(`Paperclip reassign failed: ${patchResponse?.status} ${detail}`);
  }

  // Fallback: create a new issue if no existing work item was found
  const lines = String(body).split("\n");
  const title = lines[0] ? `${lines[0]} needs an update` : `Pull request update ${submissionId}`;
  const description = [
    body,
    "",
    "---",
    `Dispatched by the pr-updater runner. Submission id: ${submissionId}`,
    "Your branch is already checked out. Do not switch, create, or reset branches.",
  ].join("\n");

  const url = `${config.paperclipApiUrl}/api/companies/${config.paperclipCompanyId}/issues`;
  const postOptions = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      description,
      projectId: config.paperclipProjectId,
      assigneeAgentId: config.paperclipAgentId || agentId,
      status: "todo",
      ...workspace,
    }),
  };

  let response;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      response = await fetchImpl(url, postOptions);
      break;
    } catch (error) {
      if (attempt === 2) throw new Error(`Paperclip assignment failed after retry: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const payload = await response.json();
  if (!response.ok || !payload?.id || !["todo", "in_progress"].includes(payload.status)) {
    throw new Error(`Paperclip assignment failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  await rememberJob(config, submissionId, payload);
  return payload;
}

/**
 * What became of one dispatched job.
 *
 * The issue status is the agent's own report and is preferred. It is not trusted as the only
 * signal: an agent that exits without setting a status would otherwise leave the job open forever
 * and stall every later pull request, so a run that finished and stayed finished also closes it.
 */
export async function getConversations(config, submissionId, fetchImpl = fetch) {
  const map = await readJobMap(config);
  const entry = map[submissionId];
  if (!entry?.issueId) {
    // A job with no mapping was dispatched to the harness before this runner moved to Paperclip.
    // Nothing here can ever learn its outcome, and leaving it open holds the single dispatch slot
    // shut forever, so it is closed out instead of stalling every later pull request.
    return {
      completedAt: new Date().toISOString(),
      outcome: "completed",
      text: "Dispatched before the Paperclip migration; closed without an outcome.",
    };
  }

  const base = config.paperclipApiUrl;
  let issue;
  try {
    issue = await getJson(`${base}/api/issues/${entry.issueId}`, fetchImpl);
  } catch {
    return null;
  }

  if (issue.activeRun) return null;

  let runs;
  try {
    const payload = await getJson(`${base}/api/issues/${entry.issueId}/runs`, fetchImpl);
    runs = Array.isArray(payload) ? payload : payload.runs || [];
  } catch {
    return null;
  }
  if (runs.some((run) => !FINISHED_RUN.includes(String(run.status)))) return null;
  if (TERMINAL_ISSUE.includes(String(issue.status))
    && Date.parse(issue.updatedAt || issue.completedAt || "") >= Date.parse(entry.at)) {
    return {
      completedAt: issue.updatedAt || issue.completedAt || new Date().toISOString(),
      outcome: issue.status === "done" || issue.status === "in_review" ? "completed" : issue.status,
      text: null,
    };
  }
  if (runs.length === 0) return null;

  const jobDispatchedAt = Date.parse(entry.at || "");

  let newest = null;
  for (const run of runs) {
    const at = Date.parse(run.finishedAt || run.createdAt || "");
    if (!Number.isFinite(at)) continue;
    if (Number.isFinite(jobDispatchedAt) && at < jobDispatchedAt) continue;
    if (!newest || at > newest.at) newest = { at, run };
  }
  if (!newest) return null;
  if (Date.now() - newest.at < ABANDONED_GRACE_MS) return null;

  return {
    completedAt: new Date(newest.at).toISOString(),
    outcome: "failed",
    text: `Agent exited without setting the issue status. Last run ${newest.run.runId} ended ${newest.run.status}.`,
  };
}

/**
 * The agent's current state, as Paperclip sees it.
 *
 * A failed lookup reports busy, for the same reason the harness client did: pausing costs one poll
 * interval, while guessing idle wrongly starts a second job on a clone the first one is using.
 */
export async function agentState(config, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const url = `${config.paperclipApiUrl}/api/agents/${config.paperclipAgentId}`;
  let agent;
  try {
    agent = await getJson(url, fetchImpl);
  } catch (error) {
    return { busy: true, status: "unknown", reason: `paperclip status unavailable: ${error.message}` };
  }

  const status = String(agent.status || "unknown");
  if (STOPPED.includes(status)) {
    return { busy: true, status, reason: `${agent.name || config.paperclipAgentId} is ${status}` };
  }
  return { busy: false, status, reason: `${agent.name || config.paperclipAgentId} is ${status}` };
}
