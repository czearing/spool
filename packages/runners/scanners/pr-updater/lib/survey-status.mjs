import { buildSummary, readyToMerge } from "./merge-readiness.mjs";

export function surveyStatus(surveyed, config) {
  return surveyed.map(entry => ({
    id: entry.pr.id,
    title: entry.pr.title,
    url: entry.pr.url,
    branch: entry.pr.branch,
    sourceCommit: entry.pr.sourceCommit,
    mergeStatus: entry.pr.mergeStatus,
    build: buildSummary(entry.builds),
    approvals: entry.approval?.approvals ?? 0,
    reviewers: entry.approval?.reviewers ?? 0,
    approvalLabel: entry.approval?.label ?? "0",
    unresolved: entry.counts?.unresolved ?? 0,
    unresolvedHuman: entry.counts?.human?.length ?? 0,
    unresolvedAutomated: entry.counts?.automated?.length ?? 0,
    ready: readyToMerge(entry),
    trigger: entry.verdict?.trigger || null,
    actionable: !!entry.send,
    reason: entry.verdict?.reason || entry.holdingReason || "nothing outstanding",
    dispatchOwner: !config.shard || Number(entry.pr.id) % config.shard.total === config.shard.index,
    dispatchHold: entry.holdingReason || null,
  }));
}
