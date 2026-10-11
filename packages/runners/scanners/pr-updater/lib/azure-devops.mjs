/**
 * Azure DevOps reads for the updater.
 *
 * REST with one cached token rather than a shell out per call. `az account get-access-token` was
 * measured timing out under contention with other runners, and each timeout cost a whole poll
 * interval of blindness, so the token is fetched once and reused until it is close to expiring.
 * No regular expressions are used.
 */
import { accessToken, clearToken, getJson, requestJson } from "./ado-transport.mjs";
import { policyUrl } from "./build-evidence.mjs";
export { listBuilds } from "./build-evidence.mjs";

export { accessToken, clearToken };

function apiBase(config) {
  return `${config.organization}/${encodeURIComponent(config.project)}/_apis/git/repositories/${encodeURIComponent(config.repository)}`;
}

/**
 * Resolve a comment thread.
 *
 * The only write here that touches somebody's review surface, so it is deliberately narrow: the
 * caller names one thread and the status it should end in, and nothing else about the thread is
 * altered.
 */
export async function updateThreadStatus(config, prId, threadId, status, options = {}) {
  const token = options.token || accessToken();
  const fetchImpl = options.fetchImpl || fetch;
  const url = `${apiBase(config)}/pullRequests/${prId}/threads/${threadId}?api-version=7.1`;
  await requestJson(url, {
    method: "PATCH",
    token, fetchImpl, metric: "PATCH thread",
    body: { status },
    invalidate: [`${apiBase(config)}/pullRequests/${prId}/threads?api-version=7.1`],
  });
  return true;
}

/**
 * Active pull requests opened under one identity.
 *
 * Filtered by the service rather than by the caller: every agent pushes with the same credential,
 * and the repository is far busier than any bounded page, so a client-side filter would silently
 * drop the oldest owned pull requests off the end of the list.
 */
export async function listOwnPullRequests(config, options = {}) {
  const token = options.token || accessToken();
  const fetchImpl = options.fetchImpl || fetch;
  const query = new URLSearchParams({
    "searchCriteria.status": options.status || "active",
    "$top": String(options.top || 100),
    "api-version": "7.1",
  });
  if (config.creatorId) query.set("searchCriteria.creatorId", config.creatorId);
  if (options.sourceBranch) query.set("searchCriteria.sourceRefName",
    options.sourceBranch.startsWith("refs/heads/") ? options.sourceBranch : `refs/heads/${options.sourceBranch}`);
  const result = [], pageSize = options.top || 100;
  for (let skip = 0; ; skip += pageSize) {
    if (options.allPages) query.set("$skip", String(skip));
    const payload = await getJson(`${apiBase(config)}/pullRequests?${query}`, token, fetchImpl, options.refresh,
      { cacheMs: config.adoCacheMs ?? 60_000, metric: "GET own PRs" });
    if (!Array.isArray(payload.value)) throw new Error("Invalid PR list response");
    result.push(...payload.value.map(normalizePullRequest.bind(null, config)));
    if (!options.allPages || payload.value.length < pageSize) return result;
  }
}

/** Reduce a pull request payload to the fields any decision here actually reads. */
export function normalizePullRequest(config, value) {
  return {
    id: String(value.pullRequestId),
    title: value.title || "",
    description: value.description || "",
    status: value.status,
    isDraft: value.isDraft === true,
    branch: String(value.sourceRefName || "").split("refs/heads/").join(""),
    targetBranch: String(value.targetRefName || "").split("refs/heads/").join(""),
    targetCommit: value.lastMergeTargetCommit?.commitId || "",
    sourceCommit: value.lastMergeSourceCommit?.commitId || "",
    sourceCommitDate: value.lastMergeSourceCommit?.author?.date || value.lastMergeSourceCommit?.committer?.date || null,
    mergeStatus: value.mergeStatus || "unknown",
    author: value.createdBy?.uniqueName || "",
    // Reviewer votes, kept as numbers: 10 approved, 5 approved with suggestions, -5 waiting,
    // -10 rejected. Needed to say whether a pull request can actually land, which a green build
    // alone does not establish.
    votes: (value.reviewers || []).map((reviewer) => Number(reviewer.vote) || 0),
    // The reviewer roster, kept whole. Telling a pipeline from a person needs to know who was
    // actually asked to review, which a bare list of vote numbers cannot answer.
    reviewers: (value.reviewers || []).map((reviewer) => ({
      id: reviewer.id || "",
      uniqueName: reviewer.uniqueName || "",
      displayName: reviewer.displayName || "",
      vote: Number(reviewer.vote) || 0,
      isContainer: reviewer.isContainer === true,
    })),
    url: `${config.organization}/${encodeURIComponent(config.project)}/_git/${encodeURIComponent(config.repository)}/pullrequest/${value.pullRequestId}`,
  };
}

/**
 * One pull request, read fresh rather than from a cached list.
 *
 * `resolve-thread.mjs` needs this to answer one question just before it writes: what commit is
 * actually live on this pull request right now. A cached `listOwnPullRequests` result can be
 * stale by exactly the push that is supposed to justify the resolve, so this always asks Azure
 * DevOps directly.
 */
export async function getPullRequest(config, prId, options = {}) {
  const token = options.token || accessToken();
  const fetchImpl = options.fetchImpl || fetch;
  const payload = await getJson(`${apiBase(config)}/pullRequests/${prId}?api-version=7.1`, token, fetchImpl, options.refresh,
    { metric: "GET fresh PR" });
  return normalizePullRequest(config, payload);
}

export async function getCommit(config, commitId, options = {}) {
  const token = options.token || accessToken();
  const fetchImpl = options.fetchImpl || fetch;
  const payload = await getJson(`${apiBase(config)}/commits/${commitId}?api-version=7.1`, token, fetchImpl, options.refresh,
    { cacheMs: 86_400_000, metric: "GET commit" });
  return {
    id: payload.commitId || commitId,
    authorDate: payload.author?.date || null,
    committerDate: payload.committer?.date || null,
    date: payload.committer?.date || payload.author?.date || null,
  };
}

export async function listThreads(config, prId, options = {}) {
  const token = options.token || accessToken();
  const fetchImpl = options.fetchImpl || fetch;
  const payload = await getJson(`${apiBase(config)}/pullRequests/${prId}/threads?api-version=7.1`, token, fetchImpl, options.refresh,
    { cacheMs: options.fresh ? 0 : config.adoCacheMs ?? 60_000, metric: "GET PR threads" });
  return payload.value || [];
}

/**
 * Ask Azure DevOps to run a build policy again.
 *
 * The retry that has to happen before a failure is worth an agent's turn. The evaluation id, not
 * the build id, is what the API accepts: a requeue produces a new build, so addressing the old
 * one would target something already finished.
 */
export async function requeuePolicy(config, evaluationId, options = {}) {
  const token = options.token || accessToken();
  const fetchImpl = options.fetchImpl || fetch;
  const url = `${config.organization}/${encodeURIComponent(config.project)}/_apis/policy/evaluations/${evaluationId}?api-version=7.1-preview.1`;
  await requestJson(url, {
    method: "PATCH", token, fetchImpl, metric: "PATCH policy requeue",
    invalidate: options.prId ? [policyUrl(config, options.prId)] : [],
  });
  return true;
}
