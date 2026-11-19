import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { accessToken, adoCacheIdentity, requestJson } from "../../lib/ado-transport.mjs";
import { connectCodespaceEvents } from "../../lib/codespace-pr-events.mjs";
import { syncPullRequestIndex } from "../../lib/incremental-pr-index.mjs";
import { syncPollingPullRequestIndex } from "../../lib/polling-pr-index.mjs";
import { writeRunnerJsonAsync } from "../../../packages/bohemia-agent-tooling/src/index.js";
import { readCodespaceConfig, shellQuote } from "../../../packages/repository-mcp/src/codespaces/config.mjs";
import { CodespaceTransport } from "../../../packages/repository-mcp/src/codespaces/transport.mjs";
import { pathScopeCache, mergeBaseProgram, scopeByDirectoryGroups } from "./path-scope.mjs";
import { isTouchdownPullRequest, reportPullRequests, scanAssignedPullRequests } from "./azure-devops.mjs";

const sha = /^[a-f0-9]{40}$/i;
const hash = value => createHash("sha256").update(value).digest("hex");
const types = ["git.pullrequest.created", "git.pullrequest.updated", "git.pullrequest.merged", "git.push"];
const authoritativeComparison = (comparison, source, target) =>
  sha.test(comparison.commonCommit || "") && comparison.baseCommit === target && comparison.targetCommit === source &&
  (comparison.changes === undefined || Array.isArray(comparison.changes) && comparison.changes.length === 0);
function context(config) {
  const discovery = config.directoryDiscovery, scope = config.scopes?.[0];
  if (!discovery || !path.isAbsolute(discovery.stateDirectory || "") ||
      !Array.isArray(config.scopes) || config.scopes.length !== 1 ||
      !config.codespaceReviewConfig || !/^[a-f0-9-]{36}$/i.test(discovery.repositoryId || "") ||
      !/^[a-f0-9-]{36}$/i.test(discovery.projectId || "") || !Array.isArray(discovery.scopes) || !discovery.scopes.length)
    throw new Error("Directory review discovery requires explicit repository, event storage and package scopes");
  const base = `${scope.organization.replace(/\/+$/, "")}/${encodeURIComponent(discovery.projectId)}` +
    `/_apis/git/repositories/${discovery.repositoryId}`;
  return { discovery, scope, base };
}

export async function scanDirectoryPullRequests(config, options = {}, now = new Date()) {
  const { discovery, scope, base } = context(config);
  const token = options.token || accessToken();
  const request = options.requestJson || requestJson;
  const api = (suffix, policy = {}) => request(`${base}${suffix}${suffix.includes("?") ? "&" : "?"}api-version=7.1`, {
    token, ...policy,
  });
  const polling = discovery.mode === "poll";
  if (discovery.mode !== undefined && !["poll", "events"].includes(discovery.mode))
    throw new Error("Unsupported directory discovery mode");
  if (!polling) {
    const subscriptions = JSON.parse(await fs.readFile(path.join(discovery.stateDirectory, "subscriptions.json"), "utf8"));
    if (subscriptions.repository !== discovery.repositoryId || subscriptions.project !== discovery.projectId ||
        types.some(type => !subscriptions.subscriptions?.some(subscription => subscription.eventType === type)))
      throw new Error("The repository change feed is not completely registered");
    for (const subscription of subscriptions.subscriptions) {
      const actual = await request(`${scope.organization.replace(/\/+$/, "")}/_apis/hooks/subscriptions/` +
        `${encodeURIComponent(subscription.id)}?api-version=7.1`, { token, cacheMs: 300000, metric: "review-index.feed-health" });
      if (actual.status !== "enabled" || actual.publisherInputs?.repository !== discovery.repositoryId ||
          actual.publisherInputs?.projectId !== discovery.projectId || actual.eventType !== subscription.eventType)
        throw new Error("The repository change feed is unhealthy; no bulk-scan fallback is permitted");
    }
  }
  const feed = options.feed || (polling ? {
    remote: new CodespaceTransport(readCodespaceConfig(config.codespaceReviewConfig)),
    async dispose() { await this.remote.dispose(); },
  } : await connectCodespaceEvents({ configFile: config.codespaceReviewConfig,
    directory: discovery.stateDirectory, repository: discovery.repositoryId, project: discovery.projectId }));
  try {
    let inventoryRequests = 0;
    const cutoff = now.getTime() - config.maxAgeDays * 86400000;
    const classify = async pullRequests => {
      // Drafts and previously voted PRs remain watched; this is scope discovery, not review admission.
      const reviewable = pullRequests.filter(pr => !isTouchdownPullRequest(pr));
      const candidates = polling ? reportPullRequests(reviewable.map(pr => ({ ...pr, isDraft: false,
        reviewers: (pr.reviewers || []).map(reviewer => ({ ...reviewer, vote: 0 })) })),
      scope, config.reviewer, config.maxAgeDays, now, new Set(pullRequests.map(pr => String(pr.pullRequestId)))).eligible
        : reviewable.map(pr => ({ id: String(pr.pullRequestId) }));
      const candidateIds = new Set(candidates.map(pr => pr.id));
      const cacheFile = path.join(discovery.stateDirectory, "directory-trees.json");
      let saved;
      try { saved = JSON.parse(await fs.readFile(cacheFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const cache = pathScopeCache(discovery.repositoryId, saved);
      cache.baseChecks ??= {};
      const deferred = [];
      let missingBases = 0;
      const grouped = await scopeByDirectoryGroups(pullRequests.filter(pr => candidateIds.has(String(pr.pullRequestId))).map(pr => ({
        id: String(pr.pullRequestId), sourceCommit: pr.lastMergeSourceCommit.commitId,
        targetCommit: pr.lastMergeTargetCommit.commitId,
      })), {
        repository: discovery.repositoryId, scopes: discovery.scopes, cache, batchSize: polling ? 50 : 1000,
        onDeferred: pr => deferred.push(pr.id),
        checkpoint: value => writeRunnerJsonAsync(cacheFile, value),
        mergeBases: async pairs => {
          if (polling && !options.feed && !feed.remote.env) await feed.remote.environment();
          const { stdout } = await feed.remote.ssh(
            `${shellQuote(feed.remote.config.nativeProfile.nodeExecutable)} -e ` +
            shellQuote(mergeBaseProgram(feed.remote.config.remoteRoot)), 180, undefined, JSON.stringify(pairs));
          const results = JSON.parse(stdout);
          const recoveryLimit = polling && options.bootstrap === true ? 10000 : 50;
          const missing = results.filter(pair => !sha.test(pair.commonCommit || ""))
            .slice(0, Math.max(0, recoveryLimit - missingBases));
          missingBases += missing.length;
          let next = 0;
          const recover = async () => {
            while (next < missing.length) {
              const pair = missing[next++];
              const bases = await api(`/commits/${pair.sourceCommit}/mergebases?otherCommitId=${pair.targetCommit}`,
                { cacheMs: 60000, metric: "review-index.missing-base" });
              if (!Array.isArray(bases.value)) throw new Error("Incomplete authoritative merge-base response");
              cache.baseChecks[`${pair.sourceCommit}:${pair.targetCommit}`] = Date.now();
              if (bases.value.length === 0) continue;
              if (bases.value.length === 1 && sha.test(bases.value[0].commitId || "")) pair.commonCommit = bases.value[0].commitId;
              else {
                const comparison = await api(`/diffs/commits?baseVersion=${pair.targetCommit}&baseVersionType=commit` +
                  `&targetVersion=${pair.sourceCommit}&targetVersionType=commit&diffCommonCommit=true&$top=0`,
                { cacheMs: 86400000, metric: "review-index.common-base" });
                if (!authoritativeComparison(comparison, pair.sourceCommit, pair.targetCommit) ||
                    !bases.value.some(base => base.commitId === comparison.commonCommit))
                  throw new Error("No authoritative comparison base is available");
                pair.commonCommit = comparison.commonCommit;
              }
            }
          };
          const recovered = await Promise.allSettled(Array.from({ length: Math.min(4, missing.length) }, recover));
          const failed = recovered.find(result => result.status === "rejected");
          if (failed) throw failed.reason;
          return results;
        },
        requestItems: body => api("/itemsbatch", { method: "POST", body, metric: "review-index.directory-trees" }),
      });
      // Unresolved PRs stay watched; uncertainty must not look like a removed assignment.
      return { matchedIds: [...new Set([...grouped.flatMap(group => group.pullRequests.map(pr => String(pr.id))),
        ...deferred])], grouped, deferred };
    };
    const identity = hash(`${adoCacheIdentity(base, token)}:${JSON.stringify({ repository: discovery.repositoryId,
      project: discovery.projectId, maxAgeDays: config.maxAgeDays, ...(polling ? { scopes: discovery.scopes } : {}) })}`);
    const indexed = polling ? await syncPollingPullRequestIndex({
      file: path.join(discovery.stateDirectory, "polling-inventory.json"), identity,
      repository: discovery.repositoryId, project: discovery.projectId, request: api, classify,
      now, maxAgeDays: config.maxAgeDays, allowBootstrap: options.bootstrap === true,
    }) : await syncPullRequestIndex({
      file: path.join(discovery.stateDirectory, "inventory.json"),
      identity,
      repository: discovery.repositoryId, project: discovery.projectId,
      allowBootstrap: options.bootstrap === true,
      readEvents: feed.readEvents,
      loadSnapshot: async () => {
        const values = new Map(), snapshot = new Date().toISOString();
        const minimum = new Date(Math.floor(cutoff / 86400000) * 86400000).toISOString();
        for (let skip = 0; skip < 100000; skip += 1000) {
          // A closure must not remove a row and shift later offset pages during bootstrap.
          const query = new URLSearchParams({ "searchCriteria.status": "all",
            "searchCriteria.minTime": minimum, "searchCriteria.maxTime": snapshot,
            "searchCriteria.queryTimeRangeType": "created", "$top": "1000", "$skip": String(skip) });
          const result = await api(`/pullrequests?${query}`, { metric: "review-index.bootstrap" });
          inventoryRequests++;
          if (!Array.isArray(result.value)) throw new Error("Incomplete repository bootstrap");
          for (const pr of result.value) {
            if (values.has(String(pr.pullRequestId))) throw new Error("Repository inventory shifted during bootstrap; retry");
            values.set(String(pr.pullRequestId), pr);
          }
          if (result.value.length < 1000) return { complete: true, pullRequests: [...values.values()] };
        }
        throw new Error("Repository bootstrap did not complete");
      },
      readPullRequest: id => api(`/pullrequests/${id}`, { metric: "review-index.changed-pr" }),
      readRef: async name => {
        const response = await api(`/refs?filter=${encodeURIComponent(name.replace(/^refs\//, ""))}`,
          { metric: "review-index.changed-target" });
        const matches = response.value?.filter(ref => ref.name === name);
        if (matches?.length !== 1) throw new Error("Target reference did not resolve uniquely");
        return matches[0].objectId;
      },
      include: pr => new Date(pr.creationDate).getTime() >= cutoff,
    });
    const { grouped, deferred = [] } = indexed.classification || await classify(indexed.pullRequests);
    const matched = new Set(grouped.flatMap(group => group.pullRequests.map(pr => String(pr.id))));
    const held = new Set(deferred);
    const directoryReport = reportPullRequests(indexed.pullRequests.filter(pr =>
      matched.has(String(pr.pullRequestId)) || held.has(String(pr.pullRequestId))),
      scope, config.reviewer, config.maxAgeDays, now, new Set([...matched, ...held]));
    directoryReport.detected = directoryReport.detected.map(pr => held.has(pr.id)
      ? { ...pr, eligible: false, comparisonDeferred: pr.eligible,
        reasons: [...pr.reasons, "No authoritative comparison base is available; review deferred"] } : pr);
    directoryReport.eligible = directoryReport.eligible.filter(pr => !held.has(pr.id));
    const assigned = await (options.scanAssigned || scanAssignedPullRequests)(config, { ...options, token }, now);
    const unique = values => [...new Map(values.map(pr => [pr.id, pr])).values()];
    return {
      detected: unique([...directoryReport.detected, ...assigned.detected]),
      eligible: unique([...directoryReport.eligible, ...assigned.eligible]),
      discovery: { mode: polling ? "poll" : "events", cursor: indexed.cursor, ...indexed.metrics, inventoryRequests,
        deferredPullRequests: deferred.length,
        scopes: grouped.map(group => ({ id: group.id, matches: group.pullRequests.length })) },
    };
  } finally { if (!options.feed) await feed.dispose(); }
}

export async function scanDirectoryPullRequest(config, pr, options = {}, now = new Date()) {
  const { scope, base } = context(config);
  const request = options.requestJson || requestJson, token = options.token || accessToken();
  const actual = await request(`${base}/pullrequests/${encodeURIComponent(pr.id)}?api-version=7.1`, {
    token, metric: "review-index.verify-current-pr",
  });
  if (String(actual.pullRequestId) !== String(pr.id) || actual.repository?.id !== config.directoryDiscovery.repositoryId)
    throw new Error("Review freshness lookup returned another PR");
  if (pr.discovery === "path") {
    if (actual.lastMergeSourceCommit?.commitId !== pr.sourceCommit) return { detected: [], eligible: [] };
    if (actual.lastMergeTargetCommit?.commitId !== pr.targetCommit) {
      const comparisonBase = async target => {
        if (!sha.test(pr.sourceCommit || "") || !sha.test(target || ""))
          throw new Error("Review freshness lookup has no pinned comparison identities");
        const comparison = await request(`${base}/diffs/commits?baseVersion=${target}&baseVersionType=commit` +
          `&targetVersion=${pr.sourceCommit}&targetVersionType=commit&diffCommonCommit=true&$top=0&api-version=7.1`,
        { token, cacheMs: 86400000, metric: "review-index.verify-comparison-base" });
        if (!authoritativeComparison(comparison, pr.sourceCommit, target))
          throw new Error("Review freshness lookup has no authoritative comparison base");
        return comparison.commonCommit;
      };
      const [previous, current] = await Promise.all([
        comparisonBase(pr.targetCommit), comparisonBase(actual.lastMergeTargetCommit?.commitId),
      ]);
      if (previous !== current) return { detected: [], eligible: [] };
    }
  }
  return reportPullRequests([actual], scope, config.reviewer, config.maxAgeDays, now,
    pr.discovery === "path" ? new Set([String(pr.id)]) : new Set());
}
