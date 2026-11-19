import { readReviewerJson, resolveReviewer, resolveReviewerGroups } from "./reviewer-identities.mjs";

export const isTouchdownPullRequest = pr => /\btouchdown\b/i.test(pr.title || "");

export async function scanAssignedPullRequests(config, options = {}, now = new Date()) {
  const scopes = [];
  for (const scope of config.scopes) {
    if (options.pullRequest && (scope.organization !== options.pullRequest.organization
      || scope.project !== options.pullRequest.project
      || scope.repository && scope.repository !== options.pullRequest.repository)) continue;
    scopes.push(await queryScopeReport(scope, config.reviewer, options, config.maxAgeDays, now));
  }
  return {
    eligible: scopes.flatMap((scope) => scope.eligible),
    detected: scopes.flatMap((scope) => scope.detected),
  };
}

export async function queryScopeReport(
  scope,
  reviewerEmail,
  options = {},
  maxAgeDays = 30,
  now = new Date(),
) {
  // Keep the explicit CLI fixture seam; production never spawns a PR-list command.
  const result = typeof options === "function" ? { pullRequests: JSON.parse(await options([
    "repos", "pr", "list",
    "--organization", scope.organization,
    "--project", scope.project,
    "--status", "active",
    "--reviewer", reviewerEmail,
    "--top", "1000",
    "--only-show-errors",
    "--output", "json",
  ])) } : await listAssigned(scope, reviewerEmail, options, now);
  return reportPullRequests(result.pullRequests, scope, reviewerEmail, maxAgeDays, now, new Set(), result.reviewer);
}

export function reportPullRequests(pullRequests, scope, reviewerEmail, maxAgeDays = 30, now = new Date(),
  pathMatches = new Set(), reviewer = {}) {
  if (!Array.isArray(pullRequests)) throw new Error("Azure DevOps returned an invalid pull request list");
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const scoped = scope.repository ? pullRequests.filter(pr => pr.repository?.name === scope.repository) : pullRequests;
  const detected = scoped.map((pr) => {
    const assignedReviewer = reviewerIdentity(pr, reviewerEmail, reviewer.id);
    const assignedGroups = (pr.reviewers || []).filter(identity => reviewer.groups?.has(identity.id));
    const vote = assignedReviewer ? assignedReviewer.vote : assignedGroups.length ? 0 : undefined;
    const selfAuthored = isSelfAuthored(pr, reviewerEmail, reviewer.id);
    const createdAt = new Date(pr.creationDate);
    const sourceCommit = pr.lastMergeSourceCommit?.commitId || "";
    const reasons = [
      ...(pr.status === "active" ? [] : [`status is ${pr.status}`]),
      ...(pr.isDraft === true ? ["draft"] : []),
      ...(isTouchdownPullRequest(pr) ? ["Touchdown PRs are excluded"] : []),
      ...(pathMatches.has(String(pr.pullRequestId)) && !assignedReviewer && !assignedGroups.length && isBotAuthored(pr)
        ? ["bot-authored; not explicitly assigned to the reviewer"] : []),
      ...(/^[0-9a-f]{40}$/i.test(sourceCommit) ? [] : ["source commit is missing or invalid"]),
      ...(selfAuthored ? ["authored by the reviewer"] : []),
      ...(assignedReviewer?.hasDeclined === true ? ["reviewer declined"] : []),
      ...(vote === 0 || (vote === undefined && pathMatches.has(String(pr.pullRequestId)))
        ? [] : [`reviewer vote is ${vote ?? "missing"}`]),
      ...(createdAt.getTime() >= cutoff ? [] : [`older than ${maxAgeDays} days`]),
    ];
    return {
      id: String(pr.pullRequestId),
      title: pr.title,
      repository: pr.repository?.name || "Unknown",
      organization: scope.organization,
      project: scope.project,
      status: pr.status,
      isDraft: pr.isDraft === true,
      selfAuthored,
      reviewerVote: vote,
      ...(assignedGroups.length ? { reviewerGroups: assignedGroups.map(group => reviewer.groups.get(group.id)) } : {}),
      creationDate: pr.creationDate,
      sourceCommit,
      targetCommit: pr.lastMergeTargetCommit?.commitId || "",
      ...(pathMatches.has(String(pr.pullRequestId)) ? {
        discovery: "path",
      } : !assignedReviewer && assignedGroups.length ? { discovery: "group" } : {}),
      olderThanMaxAge: createdAt.getTime() < cutoff,
      eligible: reasons.length === 0,
      reasons,
      url: `${scope.organization}/${encodeURIComponent(scope.project)}/_git/${encodeURIComponent(pr.repository.name)}/pullrequest/${pr.pullRequestId}`,
    };
  });
  const eligibleById = new Map(detected.filter((pr) => pr.eligible).map((pr) => [pr.id, pr]));
  const eligible = scoped
    .filter((pr) => eligibleById.has(String(pr.pullRequestId)))
    .map((pr) => ({
      id: String(pr.pullRequestId),
      title: pr.title,
      author: pr.createdBy?.uniqueName || pr.createdBy?.displayName || "Unknown",
      organization: scope.organization,
      project: scope.project,
      repository: pr.repository.name,
      sourceBranch: pr.sourceRefName,
      targetBranch: pr.targetRefName,
      sourceCommit: pr.lastMergeSourceCommit?.commitId || "",
      targetCommit: pr.lastMergeTargetCommit?.commitId || "",
      ...(eligibleById.get(String(pr.pullRequestId)).reviewerGroups
        ? { reviewerGroups: eligibleById.get(String(pr.pullRequestId)).reviewerGroups } : {}),
      ...(pathMatches.has(String(pr.pullRequestId)) ? {
        discovery: "path",
      } : !reviewerIdentity(pr, reviewerEmail, reviewer.id) && pr.reviewers?.some(group => reviewer.groups?.has(group.id))
        ? { discovery: "group" } : {}),
      url: `${scope.organization}/${encodeURIComponent(scope.project)}/_git/${encodeURIComponent(pr.repository.name)}/pullrequest/${pr.pullRequestId}`,
    }));
  return { detected, eligible };
}

// The --reviewer query cannot distinguish a self-added reviewer from a genuine review request, so
// authorship is the only signal that keeps the reviewer off its own operator's pull requests.
function isSelfAuthored(pullRequest, reviewerEmail, reviewerId) {
  if (reviewerId && pullRequest.createdBy?.id === reviewerId) return true;
  const author = String(pullRequest?.createdBy?.uniqueName || "").toLowerCase();
  const reviewer = String(reviewerEmail || "").toLowerCase();
  return author.length > 0 && reviewer.length > 0 && author === reviewer;
}

function isBotAuthored(pr) {
  const author = pr.createdBy || {};
  return author.isBot === true || author.isContainer === true ||
    /^(s2s|svc)\./i.test(String(author.descriptor || "")) ||
    String(author.uniqueName || "").trim().toLowerCase() === "wikibot@microsoft.com";
}

function reviewerIdentity(pr, reviewerEmail, reviewerId) {
  return pr.reviewers?.find(
    (candidate) => candidate.isContainer !== true && (reviewerId && candidate.id === reviewerId
      || candidate.uniqueName?.toLowerCase() === reviewerEmail.toLowerCase()),
  );
}

async function listAssigned(scope, email, options, now) {
  const reviewer = await resolveReviewer(scope, email, options);
  const base = `${scope.organization.replace(/\/+$/, "")}/${encodeURIComponent(scope.project)}/_apis/git`;
  const repository = scope.repository || options.pullRequest?.repository;
  const endpoint = repository ? `${base}/repositories/${encodeURIComponent(repository)}/pullrequests` : `${base}/pullrequests`;
  const values = new Map();
  let boundary;
  for (let skip = 0; skip < 100000; skip += 999) {
    const url = new URL(options.pullRequest ? `${endpoint}/${encodeURIComponent(options.pullRequest.id)}` : endpoint);
    url.search = new URLSearchParams({ "api-version": "7.1", ...(!options.pullRequest ? {
      "searchCriteria.status": "active", "searchCriteria.maxTime": now.toISOString(),
      "searchCriteria.queryTimeRangeType": "created", "$top": "1000", "$skip": String(skip),
    } : {}) });
    const payload = await readReviewerJson(url, options, 0, "reviewer.pullrequests");
    const page = options.pullRequest ? [payload] : payload.value;
    if (!Array.isArray(page)) throw new Error("Azure DevOps returned an invalid pull request list");
    // Overlap one row so a closure shifting offset pages cannot silently drop an assignment.
    if (boundary && String(page[0]?.pullRequestId) !== boundary) {
      throw new Error("Azure DevOps pull request inventory shifted during pagination; retry");
    }
    for (const pr of boundary ? page.slice(1) : page) {
      const id = String(pr.pullRequestId);
      if (!/^[1-9][0-9]*$/.test(id) || values.has(id)) throw new Error("Azure DevOps returned inconsistent pull request pages");
      values.set(id, pr);
    }
    if (options.pullRequest || page.length < 1000) break;
    if (skip + 999 >= 100000) throw new Error("Azure DevOps pull request pagination did not complete");
    boundary = String(page.at(-1).pullRequestId);
  }
  const pullRequests = [...values.values()].filter(pr => !scope.repository || pr.repository?.name === scope.repository);
  reviewer.groups = await resolveReviewerGroups(scope, pullRequests, reviewer, options);
  return { reviewer, pullRequests: pullRequests.filter(pr => reviewerIdentity(pr, email, reviewer.id)
    || pr.reviewers.some(group => reviewer.groups.has(group.id))) };
}
