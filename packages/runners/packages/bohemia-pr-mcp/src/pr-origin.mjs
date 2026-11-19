import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { acquireProcessLock, writeRunnerJson } from "../../bohemia-agent-tooling/src/index.js";
import { publicationFile, publicationUrl, readPublication, recordPublication } from "../../bohemia-agent-tooling/src/publications.js";
export { publicationContext as creationContext } from "../../bohemia-agent-tooling/src/publications.js";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const branchName = branch => branch.replace(/^refs\/heads\//, "");
const canonical = directory => {
  const value = realpathSync.native(directory);
  return process.platform === "win32" ? value.toLowerCase() : value;
};
const read = file => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
const marker = id => `<!-- bohemia-origin:${id} -->\n`;
const validSession = owner => uuid.test(owner?.sessionId || "") || (owner?.deferred === true && owner.sessionId === null);

export function preservePrOrigin(previous, description) {
  const prefix = previous?.match(/^<!-- bohemia-origin:([0-9a-f-]{36}) -->\r?\n/i);
  return prefix && uuid.test(prefix[1]) ? marker(prefix[1]) + description : description;
}

export function prReviewFingerprint(pr) {
  return createHash("sha256").update(`${pr.title || ""}\n${pr.description || ""}`).digest("hex");
}

export function publicationOwner({ context, pr, prUrl }) {
  if (!context) return null;
  const owner = readPublication(prUrl, context.receiptDirectory);
  if (!owner) return null;
  if (!owner.verified || owner.prId !== String(pr.pullRequestId) ||
      publicationUrl(owner.prUrl) !== publicationUrl(prUrl) || owner.branch !== branchName(pr.sourceRefName || ""))
    throw new Error("Recorded publication does not match the remote PR and source branch");
  return { file: publicationFile(prUrl, context.receiptDirectory), owner };
}

export function checkedPublication({ repoRoot, headCommit, targetRefName }) {
  const gatePath = execFileSync("git", ["rev-parse", "--git-path", "bohemia-gate-pass.json"], {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const gate = read(path.resolve(repoRoot, gatePath));
  if (!/^[a-f0-9]{40}$/i.test(headCommit || "") || gate?.head !== headCommit || !targetRefName ||
      gate.targetBranch !== `origin/${branchName(targetRefName)}` ||
      !/^[a-f0-9]{40}$/i.test(gate.targetCommit || "") || !Number.isFinite(Date.parse(gate.passedAt)))
    throw new Error("Publication continuity requires the exact successful gate target");
  const targetCommit = gate.targetCommit;
  const baseCommit = execFileSync("git", ["merge-base", headCommit, targetCommit], {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return { head: headCommit, targetCommit, baseCommit };
}

export async function recordCheckedPublication({ context, repoRoot, pr, prUrl, headCommit }) {
  if (!context) return;
  if (pr.lastMergeSourceCommit?.commitId !== headCommit || pr.status !== "active")
    throw new Error("Publication continuity requires the exact active, checked remote revision");
  const { targetCommit, baseCommit } = checkedPublication({ repoRoot, headCommit, targetRefName: pr.targetRefName });
  return recordPublication({ context, repoRoot, branch: branchName(pr.sourceRefName),
    result: { ready: true, pullRequestId: pr.pullRequestId, url: prUrl, commit: headCommit, targetCommit,
      targetBranch: branchName(pr.targetRefName) },
    publication: { baseCommit, ...(context.agent === "ci" ? { draft: pr.isDraft === true, reviewHash: prReviewFingerprint(pr) } : {}) } });
}

// Persist before POST and reconcile by marker; an ambiguous POST is never replayed.
export async function createWithOrigin({ context, input, repoRoot, api, publication, recoveryIntent, write = writeRunnerJson }) {
  if (!context) return api.create(input);
  if (!repoRoot || context.workspace && canonical(context.workspace) !== canonical(repoRoot))
    throw new Error("Publication checkout does not match the assigned execution workspace");
  const scope = api.url(input.repository, 0).replace(/0$/, "").toLowerCase();
  const branch = branchName(input.sourceBranch), targetBranch = branchName(input.targetBranch);
  const directory = path.join(context.receiptDirectory, "creations");
  mkdirSync(path.join(directory, ".pending"), { recursive: true });
  const key = createHash("sha256").update(scope + "\n" + branch).digest("hex");
  const receiptFile = path.join(directory, `${key}.json`);
  const intentFile = path.join(directory, ".pending", `${key}.json`);
  const release = await acquireProcessLock(`${scope}\n${branch}`, { namespace: "bohemia-pr-create", timeoutMs: 30_000 });
  try {
    const existing = read(receiptFile);
    let intent = read(intentFile);
    const recovering = !intent && recoveryIntent;
    if (recovering) {
      if (recoveryIntent.attempted !== true) throw new Error("Historical creation recovery requires an attempted publication");
      intent = recoveryIntent;
    }
    if (intent && (intent.version !== 1 || intent.scope !== scope || intent.branch !== branch ||
        !validSession(intent.owner) || intent.targetBranch !== targetBranch || !uuid.test(intent.originId)))
      throw new Error("Creation intent does not match this repository, source or target branch");
    if (recovering) write(intentFile, intent);
    if (existing && (!intent || existing.verified !== true || existing.originId !== intent.originId ||
        existing.prUrl?.toLowerCase() !== api.url(input.repository, Number(existing.prId)).toLowerCase() ||
        existing.targetBranch !== intent.targetBranch))
      throw new Error("Existing publication has no matching creation intent");
    if (!intent) {
      intent = { version: 1, scope, repository: input.repository, branch, targetBranch,
        owner: { originKind: context.originKind, taskId: context.taskId, agent: context.agent,
          sessionId: context.sessionId, workspace: context.workspace || repoRoot, projectRoot: context.projectRoot,
          deferred: context.deferred === true, originalPrompt: context.originalPrompt },
        publication, originId: randomUUID(), attempted: false, createdAt: new Date().toISOString() };
      write(intentFile, intent);
    }
    let pr;
    const knownId = existing?.prId || intent.prId;
    if (knownId) {
      pr = await api.get(input.repository, Number(knownId));
    } else {
      const candidates = await api.list(input.repository, branch);
      const matches = candidates.filter(candidate => candidate.description?.startsWith(marker(intent.originId)));
      if (matches.length > 1) throw new Error("Multiple PRs match the creation intent; reconciliation is ambiguous");
      if (matches.length === 1) {
        pr = await api.get(input.repository, matches[0].pullRequestId);
      } else if (intent.attempted) {
        throw new Error("PR creation outcome is uncertain; retry reconciliation, never create a replacement PR");
      } else if (candidates.length) {
        throw new Error("This branch already has a PR; use action=update");
      } else {
        intent = { ...intent, attempted: true };
        write(intentFile, intent);
        try {
          pr = await api.create({ ...input, description: marker(intent.originId) + input.description });
        } catch (error) {
          if (error.creationRejected === true && error.status === 400 &&
              error.typeKey === "GitPullRequestCannotBeActivated")
            write(intentFile, { ...intent, attempted: false, rejection: {
              status: error.status, typeKey: error.typeKey, message: error.message, at: new Date().toISOString(),
            } });
          throw error;
        }
        pr = await api.get(input.repository, pr.pullRequestId);
      }
    }
    if (!Number.isSafeInteger(pr.pullRequestId) || pr.pullRequestId <= 0 ||
        branchName(pr.sourceRefName || "") !== branch || branchName(pr.targetRefName || "") !== targetBranch ||
        !pr.description?.startsWith(marker(intent.originId)) ||
        existing && String(pr.pullRequestId) !== existing.prId)
      throw new Error("Remote PR does not match the durable creation intent");
    if (!existing)
      write(receiptFile, { version: 1, verified: true, scope, branch, targetBranch, originId: intent.originId,
        prId: String(pr.pullRequestId), prUrl: api.url(input.repository, pr.pullRequestId) });
    write(intentFile, { ...intent, prId: String(pr.pullRequestId) });
    if (!recoveryIntent && context.agent === "ci" && pr.isDraft !== true)
      throw new Error("CI experiments must remain drafts");
    const checked = intent.publication;
    if (checked) {
      if (pr.status !== "active" || pr.lastMergeSourceCommit?.commitId !== checked.head)
        throw new Error("Created PR does not retain its checked source revision");
      await recordPublication({ context, repoRoot, branch,
        result: { ready: true, pullRequestId: pr.pullRequestId, url: api.url(input.repository, pr.pullRequestId),
          commit: checked.head, targetCommit: checked.targetCommit, targetBranch },
        publication: { baseCommit: checked.baseCommit,
          ...(context.agent === "ci" ? { draft: pr.isDraft === true, reviewHash: prReviewFingerprint(pr) } : {}) } },
      { write, onlyIfAbsent: Boolean(recoveryIntent) });
    }
    return pr;
  } finally { await release(); }
}
