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
