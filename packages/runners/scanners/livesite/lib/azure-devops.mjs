import { getJson } from "../../lib/ado-transport.mjs";

export async function queryBuilds(config, definition, options = {}) {
  const payload = typeof options === "function" ? JSON.parse(await options([
    "devops", "invoke",
    "--organization", config.organization,
    "--area", "build",
    "--resource", "builds",
    "--route-parameters", `project=${config.project}`,
    "--query-parameters", `definitions=${definition.id}`, `$top=${config.maxBuilds}`,
    "--only-show-errors",
    "--output", "json",
  ])) : await read(config, "builds", {
    definitions: String(definition.id), "$top": String(config.maxBuilds),
  }, options, 30_000, "livesite.builds");
  return (payload.value || []).map((build) => ({
    id: String(build.id),
    number: build.buildNumber,
    definitionId: String(definition.id),
    definitionName: definition.name,
    status: build.status,
    result: build.result || null,
    queueTime: build.queueTime,
    startTime: build.startTime,
    finishTime: build.finishTime,
    sourceBranch: build.sourceBranch,
    sourceVersion: build.sourceVersion,
    requestedFor: build.requestedFor?.displayName || null,
    url: build._links?.web?.href
      || `${config.organization}/${encodeURIComponent(config.project)}/_build/results?buildId=${build.id}`,
  }));
}

export async function queryTimeline(config, buildId, options = {}) {
  const payload = typeof options === "function" ? JSON.parse(await options([
    "devops", "invoke",
    "--organization", config.organization,
    "--area", "build",
    "--resource", "timeline",
    "--route-parameters", `project=${config.project}`, `buildId=${buildId}`,
    "--only-show-errors",
    "--output", "json",
  ])) : await read(config, `builds/${encodeURIComponent(buildId)}/timeline`, {}, options,
    options.completed === true ? 86_400_000 : 0, "livesite.timeline");
  return (payload.records || []).map((record) => ({
    name: record.name,
    type: record.type,
    state: record.state,
    result: record.result,
    issues: (record.issues || []).map((issue) => issue.message).filter(Boolean),
  }));
}

function read(config, resource, query, options, cacheMs, metric) {
  const url = new URL(`${config.organization.replace(/\/+$/, "")}/${encodeURIComponent(config.project)}/_apis/build/${resource}`);
  url.search = new URLSearchParams({ ...query, "api-version": "7.1" });
  return (options.getJson || getJson)(url.href, options.token, options.fetchImpl, options.refresh, { cacheMs, metric });
}
