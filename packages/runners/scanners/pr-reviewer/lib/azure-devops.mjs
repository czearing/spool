import { getJson } from "../../lib/ado-transport.mjs";

export async function queryAssignedPullRequests(config, options = {}) {
  return (await scanAssignedPullRequests(config, options)).eligible;
}

export async function scanAssignedPullRequests(config, options = {}, now = new Date()) {
  const scopes = [];
  for (const scope of config.scopes) {
    scopes.push(await queryScopeReport(scope, config.reviewer, options, config.maxAgeDays, now));
  }
  return {
    eligible: scopes.flatMap((scope) => scope.eligible),
    detected: scopes.flatMap((scope) => scope.detected),
  };
}

export async function queryScope(scope, reviewerEmail, options = {}, maxAgeDays = 30, now = new Date()) {
  return (await queryScopeReport(scope, reviewerEmail, options, maxAgeDays, now)).eligible;
}

export async function queryScopeReport(
  scope,
  reviewerEmail,
  options = {},
  maxAgeDays = 30,
  now = new Date(),
) {
  // Keep the explicit CLI fixture seam; production never spawns a PR-list command.
  const pullRequests = typeof options === "function" ? JSON.parse(await options([
    "repos", "pr", "list",
    "--organization", scope.organization,
    "--project", scope.project,
    "--status", "active",
    "--reviewer", reviewerEmail,
    "--top", "1000",
    "--only-show-errors",
    "--output", "json",
  ])) : await listAssigned(scope, reviewerEmail, options);
  if (!Array.isArray(pullRequests)) throw new Error("Azure DevOps returned an invalid pull request list");
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const detected = pullRequests.map((pr) => {
    const vote = reviewerVote(pr, reviewerEmail);
    const selfAuthored = isSelfAuthored(pr, reviewerEmail);
    const createdAt = new Date(pr.creationDate);
    const sourceCommit = pr.lastMergeSourceCommit?.commitId || "";
    const reasons = [
      ...(pr.status === "active" ? [] : [`status is ${pr.status}`]),
      ...(pr.isDraft === true ? ["draft"] : []),
      ...(/^[0-9a-f]{40}$/i.test(sourceCommit) ? [] : ["source commit is missing or invalid"]),
      ...(selfAuthored ? ["authored by the reviewer"] : []),
      ...(vote === 0 ? [] : [`reviewer vote is ${vote ?? "missing"}`]),
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
      creationDate: pr.creationDate,
      sourceCommit,
      olderThanMaxAge: createdAt.getTime() < cutoff,
      eligible: reasons.length === 0,
      reasons,
      url: `${scope.organization}/${encodeURIComponent(scope.project)}/_git/${encodeURIComponent(pr.repository.name)}/pullrequest/${pr.pullRequestId}`,
    };
  });
  const eligibleIds = new Set(detected.filter((pr) => pr.eligible).map((pr) => pr.id));
  const eligible = pullRequests
    .filter((pr) => eligibleIds.has(String(pr.pullRequestId)))
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
      url: `${scope.organization}/${encodeURIComponent(scope.project)}/_git/${encodeURIComponent(pr.repository.name)}/pullrequest/${pr.pullRequestId}`,
    }));
  return { detected, eligible };
}

// The --reviewer query cannot distinguish a self-added reviewer from a genuine review request, so
// authorship is the only signal that keeps the reviewer off its own operator's pull requests.
function isSelfAuthored(pullRequest, reviewerEmail) {
  const author = String(pullRequest?.createdBy?.uniqueName || "").toLowerCase();
  const reviewer = String(reviewerEmail || "").toLowerCase();
  return author.length > 0 && reviewer.length > 0 && author === reviewer;
}

function reviewerVote(pr, reviewerEmail) {
  const reviewer = pr.reviewers?.find(
    (candidate) => candidate.uniqueName?.toLowerCase() === reviewerEmail.toLowerCase(),
  );
  return reviewer?.vote;
}

async function listAssigned(scope, reviewerEmail, options) {
  const identityUrl = new URL(`${identityOrganization(scope.organization)}/_apis/identities`);
  identityUrl.search = new URLSearchParams({
    searchFilter: "General", filterValue: reviewerEmail,
    queryMembership: "None", "api-version": "7.1",
  });
  const identities = await read(identityUrl, options, 86_400_000, "reviewer.identities");
  const email = reviewerEmail.toLowerCase();
  const matches = (identities.value || []).filter((identity) => (
    identity.id && identity.isActive !== false && identity.isContainer !== true
    && ["Account", "Mail"].some((property) => (
      String(identity.properties?.[property]?.$value || "").toLowerCase() === email
    ))
  ));
  if (matches.length !== 1) {
    throw new Error(`Azure DevOps reviewer identity must resolve uniquely for ${reviewerEmail}; found ${matches.length}`);
  }
  const url = new URL(`${scope.organization.replace(/\/+$/, "")}/${encodeURIComponent(scope.project)}/_apis/git/pullrequests`);
  url.search = new URLSearchParams({
    "searchCriteria.status": "active",
    "searchCriteria.reviewerId": matches[0].id,
    "$top": "1000",
    "api-version": "7.1",
  });
  const payload = await read(url, options, 60_000, "reviewer.pullrequests");
  if (!Array.isArray(payload.value)) throw new Error("Azure DevOps returned an invalid pull request list");
  return payload.value;
}

function read(url, options, cacheMs, metric) {
  return (options.getJson || getJson)(url.href, options.token, options.fetchImpl, options.refresh, {
    cacheMs: options.fresh ? 0 : cacheMs, metric,
  });
}

function identityOrganization(organization) {
  const url = new URL(organization);
  if (url.hostname === "dev.azure.com" && url.pathname.split("/").filter(Boolean).length === 1) {
    return `https://vssps.dev.azure.com/${url.pathname.split("/").filter(Boolean)[0]}`;
  }
  const legacy = url.hostname.match(/^([^.]+)\.visualstudio\.com$/);
  if (legacy) return `https://vssps.dev.azure.com/${legacy[1]}`;
  throw new Error(`Unsupported Azure DevOps organization for reviewer identity lookup: ${url.origin}`);
}
