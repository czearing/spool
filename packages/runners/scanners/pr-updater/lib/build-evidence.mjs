import { accessToken, getJson } from "./ado-transport.mjs";
import { infrastructureFailure } from "./build-failures.mjs";

export function policyUrl(config, prId) {
  const query = new URLSearchParams({
    artifactId: `vstfs:///CodeReview/CodeReviewId/${config.projectId}/${prId}`,
    "api-version": "7.1-preview.1",
  });
  return `${config.organization}/${encodeURIComponent(config.project)}/_apis/policy/evaluations?${query}`;
}
function buildResult(evaluation, context) {
  if (evaluation.status === "rejected") return context.isExpired === true ? "canceled" : "failed";
  return evaluation.status === "approved" ? "succeeded" : String(evaluation.status || "");
}
export async function listBuilds(config, prId, options = {}) {
  const token = options.token || accessToken(), fetchImpl = options.fetchImpl || fetch;
  const payload = await getJson(policyUrl(config, prId), token, fetchImpl, options.refresh,
    { cacheMs: config.adoCacheMs ?? 60_000, metric: "GET PR policies" });
  const builds = [];
  for (const evaluation of payload.value || []) {
    const context = evaluation.context || {};
    if (!context.buildId) continue;
    const row = { id: context.buildId, name: evaluation.configuration?.settings?.displayName || "Build",
      evaluationId: evaluation.evaluationId, result: buildResult(evaluation, context), timedOut: context.isExpired === true };
    if (row.result === "failed" && !row.timedOut) {
      const base = `${config.organization}/${encodeURIComponent(config.project)}/_apis/build/builds/${row.id}`;
      try {
        const build = await getJson(`${base}?api-version=7.1`, token, fetchImpl, options.refresh,
          { cacheMs: 60_000, metric: "GET rejected policy build" });
        if (String(build.id) !== String(row.id) || !build.status) throw new Error(`Invalid build metadata for ${row.id}`);
        if (build.status === "completed" && build.result === "canceled") {
          const timeline = await getJson(`${base}/timeline?api-version=7.1`, token, fetchImpl, options.refresh,
            { cacheMs: 60_000, metric: "GET canceled build timeline" });
          const reason = infrastructureFailure(build, timeline.records);
          if (reason) { row.failureKind = "infrastructure"; row.failureReason = reason; }
        }
      } catch (error) {
        if (error.status !== 404) throw error;
        // A missing historical build is not a code defect or a reason to stop surveying other PRs.
        row.failureKind = "unavailable";
        row.failureReason = `Build ${row.id} evidence is unavailable (404); the policy remains rejected.`;
      }
    }
    builds.push(row);
  }
  return builds;
}
