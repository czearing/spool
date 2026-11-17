export function assertActiveUpdate(current, expected = current) {
  if (!current || current.status !== "active") {
    throw new Error("Pull request is no longer active; update refused");
  }
  if (current.pullRequestId !== expected.pullRequestId ||
      current.sourceRefName !== expected.sourceRefName ||
      current.targetRefName !== expected.targetRefName) {
    throw new Error("Pull request identity or branches changed; update refused");
  }
}

export function assertCiUpdate(current, { accepted, publication,
  headCommit = current.lastMergeSourceCommit?.commitId, targetRefName = current.targetRefName }) {
  if (current.isDraft === true || accepted) return;
  if (!publication?.checked || publication.head !== current.lastMergeSourceCommit?.commitId ||
      publication.head !== headCommit || targetRefName !== current.targetRefName) {
    throw new Error("Unaccepted ready CI experiments may only update metadata for their original checked source");
  }
}
