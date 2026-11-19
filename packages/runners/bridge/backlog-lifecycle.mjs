import { assignedChild, prArtifacts, sameArtifact } from "./backlog-ado.mjs";

export function verifyBacklogPr(config, entry, repo, pr) {
  if (!Number.isSafeInteger(pr?.pullRequestId) || pr.pullRequestId < 1 ||
      pr.repository?.id !== repo.id || pr.repository?.project?.id !== config.ado.projectId ||
      pr.createdBy?.id !== config.ado.creatorId || pr.sourceRefName !== `refs/heads/${entry.branch}` ||
      pr.targetRefName !== `refs/heads/${config.baseBranch}` ||
      entry.prId && entry.prId !== pr.pullRequestId)
    throw new Error(`PR ownership/scope changed for work item ${entry.itemId}`);
}
export async function reconcileBacklogEntry({ config, entry, client, save }) {
  if (!entry.prId || !entry.branch) return { hasPr: false };
  const repo = await client.repository();
  let pr = await client.getPr(entry.prId);
  verifyBacklogPr(config, entry, repo, pr);
  entry.prId = pr.pullRequestId;
  save();
  pr = await client.getPr(entry.prId);
  verifyBacklogPr(config, entry, repo, pr);
  if (pr.status === "abandoned") {
    const retirement = entry.retirement;
    if (retirement?.reason === "superseded" && retirement.prId === pr.pullRequestId &&
        retirement.sourceCommit === pr.lastMergeSourceCommit?.commitId &&
        /^[a-f0-9]{40}$/i.test(retirement.sourceCommit || "") &&
        Number.isSafeInteger(retirement.supersededBy) && retirement.supersededBy > 0 &&
        retirement.supersededBy !== pr.pullRequestId) {
      const replacement = await client.getPr(retirement.supersededBy);
      if (replacement?.pullRequestId !== retirement.supersededBy ||
          replacement.repository?.id !== repo.id ||
          replacement.repository?.project?.id !== config.ado.projectId ||
          replacement.targetRefName !== `refs/heads/${config.baseBranch}` ||
          replacement.status !== "completed" || replacement.isDraft ||
          replacement.mergeStatus !== "succeeded" ||
          !/^[a-f0-9]{40}$/i.test(replacement.lastMergeCommit?.commitId || "") ||
          replacement.lastMergeCommit.commitId !== retirement.mergeCommit)
        throw new Error(`Superseding PR evidence changed for work item ${entry.itemId}`);
      return { hasPr: true, retired: true };
    }
    return { hasPr: true, holding: `PR ${entry.prId} was abandoned; inspect work item ${entry.itemId}` };
  }
  if (!["active", "completed"].includes(pr.status)) throw new Error(`Unexpected backlog PR status: ${pr.status}`);
  let item = await client.item(entry.itemId);
  if (!assignedChild(config, item)) return { hasPr: true, holding: `Work item ${entry.itemId} is no longer assigned in this backlog` };
  const artifact = client.artifact(repo, pr);
  if (!prArtifacts(item).some(link => sameArtifact(link.url, artifact))) {
    if (!await client.isOpen(item)) return { hasPr: true, holding: `Work item ${entry.itemId} was closed or removed outside this runner` };
    item = await client.link(item, artifact);
  }
  await client.verifyReviewers();
  pr = await client.reviewers(pr);
  verifyBacklogPr(config, entry, repo, pr);
  if (pr.status === "active") {
    if (!await client.isOpen(item)) return { hasPr: true, holding: `Work item ${entry.itemId} is not open despite an active PR` };
    return { hasPr: true };
  }
  if (pr.isDraft || pr.mergeStatus !== "succeeded" || !/^[a-f0-9]{40}$/i.test(pr.lastMergeCommit?.commitId || "") ||
      !/^[a-f0-9]{40}$/i.test(pr.lastMergeSourceCommit?.commitId || ""))
    return { hasPr: true, holding: `PR ${entry.prId} does not yet have verified merge evidence` };
  // Re-read both sides immediately before the revision-guarded closure.
  item = await client.item(entry.itemId);
  pr = await client.getPr(entry.prId);
  verifyBacklogPr(config, entry, repo, pr);
  if (!assignedChild(config, item) || !prArtifacts(item).some(link => sameArtifact(link.url, artifact)) ||
      pr.status !== "completed" || pr.isDraft || pr.mergeStatus !== "succeeded" ||
      !/^[a-f0-9]{40}$/i.test(pr.lastMergeCommit?.commitId || "") ||
      !/^[a-f0-9]{40}$/i.test(pr.lastMergeSourceCommit?.commitId || ""))
    throw new Error(`Merge/work-item association changed before closing ${entry.itemId}`);
  if (await client.isOpen(item)) item = await client.close(item);
  else if (!await client.isCompleted(item)) return { hasPr: true, holding: `Work item ${entry.itemId} was removed; closure held` };
  entry.closedAt = new Date().toISOString();
  entry.closedRevision = item.rev;
  entry.mergeCommit = pr.lastMergeCommit.commitId;
  save();
  return { hasPr: true, closed: true };
}
