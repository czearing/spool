const sha = "[a-f0-9]{40}";
export function reviewProviderInterrupted(error) {
  return /^(?:Provider closed during a turn|Native remote Copilot exited \(255\))(?:$|:)/.test(error || "");
}

export function reviewRevisionUpdate(expected, actual) {
  const valid = value => new RegExp(`^${sha}$`, "i").test(value || "");
  if (!Number.isSafeInteger(Number(expected.id)) || Number(expected.id) < 1 ||
      Number(actual.id) !== Number(expected.id) || !valid(expected.sourceCommit) ||
      !valid(expected.targetCommit) || !valid(actual.sourceCommit) || !valid(actual.targetCommit))
    return null;
  const sourceChanged = expected.sourceCommit.toLowerCase() !== actual.sourceCommit.toLowerCase();
  const targetChanged = expected.targetCommit.toLowerCase() !== actual.targetCommit.toLowerCase();
  if (!sourceChanged && !targetChanged) return null;
  return { status: "revision_changed", prId: Number(expected.id),
    previousSourceCommit: expected.sourceCommit.toLowerCase(), sourceCommit: actual.sourceCommit.toLowerCase(),
    previousTargetCommit: expected.targetCommit.toLowerCase(), targetCommit: actual.targetCommit.toLowerCase(),
    sourceChanged, targetChanged };
}

export function reviewRevisionUpdateMessage(update) {
  return `Heads up: PR ${update.prId} was updated.`;
}

const sourceSupersession = new RegExp(
  `^\\[REVIEW_SUPERSEDED\\] PR (\\d+) source changed from (${sha}) to (${sha}) \\(target (${sha})\\)\\.(?:; receipt: [^\\r\\n]+)?$`,
  "i",
);
export function reviewRevisionChange(expected, actual) {
  const valid = value => new RegExp(`^${sha}$`, "i").test(value || "");
  if (actual.id !== expected.id || !valid(expected.sourceCommit) || !valid(actual.sourceCommit) ||
      !valid(actual.targetCommit) || actual.sourceCommit.toLowerCase() === expected.sourceCommit.toLowerCase())
    return null;
  return { status: "superseded", prId: expected.id, sourceCommit: expected.sourceCommit.toLowerCase(),
    replacementSourceCommit: actual.sourceCommit.toLowerCase(), targetCommit: actual.targetCommit.toLowerCase() };
}

export function supersededReviewError(outcome) {
  const message = `[REVIEW_SUPERSEDED] PR ${outcome.prId} source changed from ` +
    `${outcome.sourceCommit} to ${outcome.replacementSourceCommit} (target ${outcome.targetCommit}).`;
  return Object.assign(new Error(message), {
    code: "review_superseded", stage: "revision", reviewOutcome: outcome,
    nextAction: "Retain the assigned revision's review evidence without automatic branch changes. " +
      "Do not approve or publish the old review against the newer source. The runner owns admission of the new revision. " +
      "Refresh stale preparation before handing off new work. An already-running review should continue " +
      "and assess the newer revisions; revision drift alone is not a reason to fail or cancel its task.",
  });
}
const nativeSupersession = new RegExp(
  `^Assigned source superseded during review: PR now points to (${sha}) \\(target (${sha})\\), while assigned checkout remains (${sha})\\. Repository MCP live reviewer guard blocked scoped check\\.$`,
  "i",
);
const localSupersession = new RegExp(
  `^Review incomplete\\s*[^\\w\\r\\n]*\\s*stale assignment: PR\\s*(\\d+) advanced from assigned source (${sha})\\s*\\(iteration\\s*\\d+\\) to (${sha})\\s*\\(iteration\\s*\\d+\\), target\\s*(${sha}); owner: PR preparation/review runner pr-reviewer$`,
  "i",
);

export function reviewSupersession(task, metadata = task?.runner_metadata) {
  if (task?.status !== "failed" || metadata?.runner !== "pr-reviewer" ||
      task.provider || task.interaction?.phase !== "ended" ||
      task.interaction?.messages?.some(message => ["queued", "delivering", "delivery_uncertain"].includes(message.status)))
    return null;
  const preparation = metadata.preparation;
  const assigned = preparation?.commit?.toLowerCase();
  const prId = Number(preparation?.pr?.id ?? preparation?.prId ??
    /^Review Azure DevOps pull request #(\d+):/.exec(task.title || "")?.[1]);
  if (!Number.isSafeInteger(prId) || prId < 1 || !new RegExp(`^${sha}$`, "i").test(assigned || "")) return null;
  const native = nativeSupersession.exec(task.error || "");
  const local = localSupersession.exec(task.error || "");
  const source = sourceSupersession.exec(task.error || "");
  if (!native && !local && !source) return null;
  const sourceCommit = (native?.[3] ?? local?.[2] ?? source[2]).toLowerCase();
  const replacementSourceCommit = (native?.[1] ?? local?.[3] ?? source[3]).toLowerCase();
  const targetCommit = (native?.[2] ?? local?.[4] ?? source[4]).toLowerCase();
  if (sourceCommit !== assigned || replacementSourceCommit === assigned ||
      local && Number(local[1]) !== prId || source && Number(source[1]) !== prId)
    return null;
  return { status: "superseded", prId, sourceCommit, replacementSourceCommit, targetCommit };
}
