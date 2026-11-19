import fs from "node:fs";
import path from "node:path";
import { azureDevOps } from "./azure-devops.mjs";
import { branchName } from "./checkout.mjs";
import { pullRequestDraft, renderPullRequest } from "./adapters/1js-pr-policy.mjs";
import { preservePrOrigin } from "../../bohemia-pr-mcp/src/pr-origin.mjs";
import { trackPublication } from "./publication-tracking.mjs";

const imagePattern = /!\[(?<alt>[^\]]*)\]\(\s*(?:<(?<angle>[^>\r\n]+)>|(?<plain>[^\s)]+))(?<caption>\s+"[^"]*")?\s*\)/g;

function repositoryHost(repo, input, options) {
  if (!["1js", "bohemia"].includes(repo)) throw new Error(`Unknown repository: ${repo}`);
  return options.host || azureDevOps({
    organization: "https://dev.azure.com/office",
    project: repo === "1js" ? "Office" : "OC",
    repository: repo === "1js" ? "1JS" : input.repository || "office-bohemia",
  }, options);
}

function assertActive(pr, expected = pr) {
  if (pr?.status !== "active") throw new Error("PR is not active");
  if (pr.pullRequestId !== expected.pullRequestId || pr.sourceRefName !== expected.sourceRefName ||
      pr.targetRefName !== expected.targetRefName || pr.title !== expected.title || pr.description !== expected.description)
    throw new Error("PR changed during the description update; read it again before retrying");
}

export async function writePullRequest(repo, input, options = {}) {
  const action = input.action || (input.pullRequestId === undefined ? "create" : "update");
  if (!["create", "update"].includes(action)) throw new Error("action must be create or update");
  if (action === "update" && (!Number.isSafeInteger(input.pullRequestId) || input.pullRequestId < 1))
    throw new Error("pullRequestId must be a positive integer");
  const host = repositoryHost(repo, input, options);
  const existing = action === "update" ? await host.get(input.pullRequestId) : null;
  if (existing) assertActive(existing);
  const draft = pullRequestDraft(input, existing);
  const rendered = renderPullRequest(draft);
  const source = branchName(existing?.sourceRefName?.replace(/^refs\/heads\//, "") || input.sourceBranch, "sourceBranch");
  const target = branchName(input.targetBranch || existing?.targetRefName?.replace(/^refs\/heads\//, "") ||
    (repo === "1js" ? "main" : "master"), "targetBranch");
  if (source === target) throw new Error("Source and target branches must differ");
  const images = [...new Set([...rendered.description.matchAll(imagePattern)]
    .map(match => match.groups.angle || match.groups.plain).filter(file => !/^https:\/\//i.test(file)))];
  for (const file of images) {
    if (!path.isAbsolute(file) || !fs.statSync(file).isFile())
      throw new Error("PR images must be existing absolute paths or hosted HTTPS URLs");
    fs.accessSync(file, fs.constants.R_OK);
  }
  // Reconcile creation against the server, not a local preparation or publication receipt.
  let pr = existing;
  if (!pr) {
    const matches = (await host.list(source)).filter(candidate => candidate.status === "active" &&
      candidate.targetRefName === `refs/heads/${target}`);
    if (matches.length > 1) throw new Error("Multiple active PRs exist for this branch; supply pullRequestId");
    if (matches.length) {
      if (matches[0].title !== rendered.title || matches[0].description !== rendered.description)
        throw new Error("An active PR already exists for this branch; use update");
      pr = await host.get(matches[0].pullRequestId);
      assertActive(pr, matches[0]);
    } else {
      pr = await host.create({ sourceRefName: `refs/heads/${source}`, targetRefName: `refs/heads/${target}`,
        ...rendered, isDraft: Boolean(input.draft) });
    }
  }
  assertActive(pr);
  if (!Number.isSafeInteger(pr.pullRequestId) || pr.pullRequestId < 1)
    throw new Error("PR creation did not return a valid ID; reconcile the branch PR before retrying");
  let description = preservePrOrigin(existing?.description, rendered.description);
  const marker = existing?.description?.match(/\n<!-- repository-mcp:[\w-]+ -->\s*$/)?.[0];
  if (marker) description += marker.trimEnd();
  for (const image of images) {
    const url = await host.upload(pr.pullRequestId, image);
    description = description.replace(imagePattern, (...args) => {
      const { alt, angle, plain, caption = "" } = args.at(-1);
      return (angle || plain) === image ? `![${alt}](${url}${caption})` : args[0];
    });
  }
  assertActive(await host.get(pr.pullRequestId), pr);
  if (pr.targetRefName !== `refs/heads/${target}`) {
    pr = await host.update(pr.pullRequestId, { targetRefName: `refs/heads/${target}` });
    if (pr.targetRefName !== `refs/heads/${target}`) throw new Error("PR retarget was not retained");
  }
  await host.update(pr.pullRequestId, { title: rendered.title, description,
    ...(input.draft !== undefined ? { isDraft: input.draft } : {}) });
  const published = await host.get(pr.pullRequestId);
  if (published.title !== rendered.title || published.description !== description ||
      published.sourceRefName !== `refs/heads/${source}` || published.targetRefName !== `refs/heads/${target}` ||
      published.status !== "active" || input.draft !== undefined && published.isDraft !== input.draft)
    throw new Error("PR readback differs from the requested update");
  const result = { ok: true, ready: true, pullRequestId: published.pullRequestId, url: host.url(published.pullRequestId),
    title: published.title, description: published.description, branch: source, targetBranch: target,
    commit: published.lastMergeSourceCommit?.commitId, targetCommit: published.lastMergeTargetCommit?.commitId };
  try { await (options.trackPublication || trackPublication)(result, {
    environment: { ...process.env, ...options.env }, repoRoot: input.repoRoot,
  }); }
  catch (error) {
    // Tracking is an observer, never a prerequisite or a reason to retry an already-published PR.
    result.trackingWarning = `PR published; optional task tracking failed: ${error.message}`;
  }
  return result;
}

export const createPullRequest = (repo, input, options) => writePullRequest(repo, { ...input, action: "create" }, options);
export const updatePullRequest = (repo, input, options) => writePullRequest(repo, { ...input, action: "update" }, options);
