export function assignmentKey(pr) {
  return [
    "azure-devops",
    pr.organization,
    pr.project,
    pr.repository,
    pr.id,
    pr.sourceCommit || "unversioned",
  ].join(":");
}

export function newlyAssigned(previousKeys, pullRequests) {
  const previous = new Set(previousKeys);
  return pullRequests.filter((pr) => !previous.has(assignmentKey(pr)));
}
