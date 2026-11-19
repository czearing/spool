import fs from "node:fs/promises";
import path from "node:path";
import { acquireProcessLock, writeRunnerJsonAsync } from "../../packages/bohemia-agent-tooling/src/index.js";

const sha = /^[a-f0-9]{40}$/i;
const validId = id => /^[1-9]\d*$/.test(String(id)) && Number.isSafeInteger(Number(id));
const iso = value => new Date(value).toISOString();
const overlapMs = 60_000;

function validate(pr, repository) {
  if (!validId(pr?.pullRequestId) || pr.repository?.id?.toLowerCase() !== repository.toLowerCase() ||
      !["active", "completed", "abandoned"].includes(pr.status) ||
      !Number.isFinite(Date.parse(pr.creationDate)) || typeof pr.isDraft !== "boolean" ||
      pr.status === "active" && (!sha.test(pr.lastMergeSourceCommit?.commitId || "") ||
        !sha.test(pr.lastMergeTargetCommit?.commitId || "") ||
        !pr.sourceRefName?.startsWith("refs/heads/") || !pr.targetRefName?.startsWith("refs/heads/")))
    throw new Error("Invalid PR identity in polling inventory");
  return Object.fromEntries(["pullRequestId", "title", "status", "isDraft", "creationDate", "createdBy",
    "reviewers", "repository", "sourceRefName", "targetRefName", "lastMergeSourceCommit",
    "lastMergeTargetCommit"].map(key => [key, pr[key]]));
}

// Creation and push deltas are fast paths. A bounded creation-window sweep catches metadata-only
// edits (including reactivation/retargeting) that the public Git REST API cannot filter by update time.
export async function syncPollingPullRequestIndex({
  file, identity, repository, project, request, classify, now = new Date(), maxAgeDays = 30,
  allowBootstrap = false, pageSize = 100, deltaPages = 2, refreshLimit = 25,
  reconcileWindowMs = 6 * 3600000,
}) {
  if (!path.isAbsolute(file) || !identity || !repository || !project ||
      !Number.isFinite(now.getTime()) || !Number.isSafeInteger(maxAgeDays) || maxAgeDays < 1 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
      !Number.isSafeInteger(deltaPages) || deltaPages < 1 || deltaPages > 10 ||
      !Number.isSafeInteger(refreshLimit) || refreshLimit < 1 || refreshLimit > 100 ||
      !Number.isSafeInteger(reconcileWindowMs) || reconcileWindowMs < 60000)
    throw new Error("Polling PR index requires explicit scope and bounded scan settings");
  const canonical = process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  const release = await acquireProcessLock(canonical, { namespace: "repository-pr-index", timeoutMs: 120000 });
  try {
    let saved;
    try { saved = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const time = now.getTime(), cutoff = time - maxAgeDays * 86400000;
    if (saved && (saved.version !== 1 || saved.identity !== identity || saved.repository !== repository ||
        saved.project !== project || !Array.isArray(saved.pullRequests) || !Array.isArray(saved.matchedIds) ||
        !Array.isArray(saved.pendingIds) || !Number.isFinite(Date.parse(saved.createdThrough)) ||
        !Number.isFinite(Date.parse(saved.pushesThrough)) ||
        Date.parse(saved.createdThrough) > time || Date.parse(saved.pushesThrough) > time))
      throw new Error("Polling PR index does not match its authorization, scope or clock");
    if (!saved && !allowBootstrap)
      throw new Error("Polling PR inventory requires explicit bootstrap; routine scans never reload the repository");
    const metrics = { bootstrapRequests: 0, creationPages: 0, pushPages: 0, reconciliationPages: 0,
      refreshedPullRequests: 0, watchedPullRequests: 0 };
    const inventory = new Map();
    const put = pr => {
      const current = validate(pr, repository);
      inventory.set(String(current.pullRequestId), current);
    };
    const prPage = async (window, size, metric) => {
      if (!Number.isFinite(Date.parse(window.from)) || !Number.isFinite(Date.parse(window.through)) ||
          Date.parse(window.from) > Date.parse(window.through) || Date.parse(window.through) > time ||
          !Number.isSafeInteger(window.skip) || window.skip < 0)
        throw new Error("Invalid polling inventory window");
      const query = new URLSearchParams({ "searchCriteria.status": "all",
        "searchCriteria.queryTimeRangeType": "created", "searchCriteria.minTime": window.from,
        "searchCriteria.maxTime": window.through, "$top": String(size), "$skip": String(window.skip) });
      const result = await request(`/pullrequests?${query}`, { metric });
      if (!Array.isArray(result?.value) || result.value.length > size)
        throw new Error("Incomplete polling PR page");
      for (const pr of result.value) {
        const created = Date.parse(pr.creationDate);
        if (!(created >= Date.parse(window.from) && created <= Date.parse(window.through)))
          throw new Error("Server ignored PR creation-window bounds");
        put(pr);
      }
      return result.value.length;
    };
    if (!saved) {
      const stagingFile = `${file}.bootstrap.json`;
      let staged;
      try { staged = JSON.parse(await fs.readFile(stagingFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (staged && (staged.identity !== identity || staged.repository !== repository || staged.project !== project ||
          !Array.isArray(staged.pullRequests) || typeof staged.complete !== "boolean" ||
          !Number.isSafeInteger(staged.skip) || staged.skip !== staged.pullRequests.length ||
          !Number.isFinite(Date.parse(staged.from)) || !Number.isFinite(Date.parse(staged.through)) ||
          Date.parse(staged.from) > Date.parse(staged.through) || Date.parse(staged.through) > time))
        throw new Error("Explicit bootstrap checkpoint changed authorization, identity or time scope");
      for (const pr of staged?.pullRequests || []) put(pr);
      if (staged && inventory.size !== staged.skip) throw new Error("Duplicate bootstrap checkpoint identities");
      const window = staged ? { from: staged.from, through: staged.through, skip: staged.skip }
        : { from: iso(cutoff), through: now.toISOString(), skip: 0 };
      while (!staged?.complete) {
        const size = await prPage(window, 1000, "review-index.bootstrap");
        metrics.bootstrapRequests++;
        if (inventory.size !== window.skip + size) throw new Error("Bootstrap pagination repeated PR identities");
        window.skip += size;
        staged = { identity, repository, project, ...window, complete: size < 1000, pullRequests: [...inventory.values()] };
        await writeRunnerJsonAsync(stagingFile, staged);
        if (!staged.complete && window.skip >= 200000) throw new Error("Explicit polling bootstrap exceeds its safety bound");
      }
      saved = { version: 1, identity, repository, project, createdThrough: window.through,
        pushesThrough: window.through, matchedIds: [], pendingIds: [], watchOffset: 0,
        reconcile: { from: iso(cutoff), through: iso(Math.min(time, cutoff + reconcileWindowMs)), skip: 0 } };
    } else {
      for (const pr of saved.pullRequests) put(pr);
      if (inventory.size !== saved.pullRequests.length) throw new Error("Duplicate PR identities in polling index");
      let window = saved.createdWindow || {
        from: iso(Math.max(cutoff, Date.parse(saved.createdThrough) - overlapMs)), through: now.toISOString(), skip: 0,
      };
      for (let page = 0; page < deltaPages; page++) {
        const size = await prPage(window, pageSize, "review-index.created-delta");
        metrics.creationPages++;
        if (size < pageSize) {
          saved.createdThrough = window.through;
          window = null;
          break;
        }
        window = { ...window, skip: window.skip + size };
      }
      saved.createdWindow = window;
    }
    const pending = new Set(saved.pendingIds.map(String));
    if ([...pending].some(id => !validId(id) || !inventory.has(id)) ||
        saved.matchedIds.some(id => !validId(id) || !inventory.has(String(id))))
      throw new Error("Invalid polling refresh identities");
    const sourceRefs = new Map();
    for (const [id, pr] of inventory) {
      const ids = sourceRefs.get(pr.sourceRefName) || [];
      ids.push(id);
      sourceRefs.set(pr.sourceRefName, ids);
    }
    let pushes = saved.pushWindow || {
      from: iso(Math.max(cutoff, Date.parse(saved.pushesThrough) - overlapMs)), through: now.toISOString(), skip: 0,
    };
    for (let page = 0; page < deltaPages; page++) {
      if (!Number.isFinite(Date.parse(pushes.from)) || !Number.isFinite(Date.parse(pushes.through)) ||
          Date.parse(pushes.from) > Date.parse(pushes.through) || Date.parse(pushes.through) > time ||
          !Number.isSafeInteger(pushes.skip) || pushes.skip < 0) throw new Error("Invalid push delta window");
      const query = new URLSearchParams({ "searchCriteria.fromDate": pushes.from,
        "searchCriteria.toDate": pushes.through, "searchCriteria.includeRefUpdates": "true",
        "$top": String(pageSize), "$skip": String(pushes.skip) });
      const result = await request(`/pushes?${query}`, { metric: "review-index.push-delta" });
      metrics.pushPages++;
      if (!Array.isArray(result?.value) || result.value.length > pageSize)
        throw new Error("Incomplete push delta page");
      for (const push of result.value) {
        const date = Date.parse(push.date);
        if (!validId(push.pushId) || push.repository?.id?.toLowerCase() !== repository.toLowerCase() ||
            !(date >= Date.parse(pushes.from) && date <= Date.parse(pushes.through)) ||
            !Array.isArray(push.refUpdates))
          throw new Error("Push delta changed repository or time scope");
        for (const ref of push.refUpdates) {
          if (typeof ref.name !== "string" || !ref.name.startsWith("refs/") || !sha.test(ref.newObjectId || ""))
            throw new Error("Invalid push reference update");
          for (const id of sourceRefs.get(ref.name) || [])
            if (inventory.get(id).lastMergeSourceCommit?.commitId !== ref.newObjectId) pending.add(id);
        }
      }
      if (result.value.length < pageSize) {
        saved.pushesThrough = pushes.through;
        pushes = null;
        break;
      }
      pushes = { ...pushes, skip: pushes.skip + result.value.length };
    }
    saved.pushWindow = pushes;
    const reconcile = saved.reconcile;
    if (!reconcile || Date.parse(reconcile.through) < cutoff) {
      saved.reconcile = { from: iso(cutoff), through: iso(Math.min(time, cutoff + reconcileWindowMs)), skip: 0 };
    }
    const window = saved.reconcile;
    const size = await prPage(window, pageSize, "review-index.metadata-reconciliation");
    metrics.reconciliationPages++;
    if (size === pageSize) saved.reconcile = { ...window, skip: window.skip + size };
    else {
      const next = Date.parse(window.through);
      saved.reconcile = next >= time
        ? { from: iso(cutoff), through: iso(Math.min(time, cutoff + reconcileWindowMs)), skip: 0 }
        : { from: iso(next), through: iso(Math.min(time, next + reconcileWindowMs)), skip: 0 };
      if (next >= time) saved.lastReconciledAt = now.toISOString();
    }
    for (const [id, pr] of inventory)
      if (Date.parse(pr.creationDate) < cutoff) { inventory.delete(id); pending.delete(id); }
    const watches = saved.matchedIds.map(String).filter(id => inventory.has(id)).sort();
    if (!Number.isSafeInteger(saved.watchOffset) || saved.watchOffset < 0) throw new Error("Invalid watch cursor");
    const offset = watches.length ? saved.watchOffset % watches.length : 0;
    const watchLimit = pending.size ? Math.floor(refreshLimit / 2) : refreshLimit;
    const watched = [...watches.slice(offset), ...watches.slice(0, offset)].slice(0, watchLimit);
    const refreshed = new Set([...pending].filter(id => !watched.includes(id))
      .slice(0, refreshLimit - watched.length).concat(watched));
    for (const id of refreshed) {
      const pr = await request(`/pullrequests/${id}`, { metric: "review-index.refresh-known-pr" });
      if (String(pr?.pullRequestId) !== id) throw new Error("Polling refresh returned another PR identity");
      put(pr);
      pending.delete(id);
      metrics.refreshedPullRequests++;
      if (watched.includes(id)) metrics.watchedPullRequests++;
    }
    saved.watchOffset = watches.length ? (offset + watched.length) % watches.length : 0;
    const current = [...inventory.values()].filter(pr =>
      pr.status === "active" && Date.parse(pr.creationDate) >= cutoff && !pending.has(String(pr.pullRequestId)));
    const classification = await classify(current);
    if (!classification || !Array.isArray(classification.matchedIds) ||
        classification.matchedIds.some(id => !current.some(pr => String(pr.pullRequestId) === String(id))))
      throw new Error("Invalid polling path classification");
    const matchedIds = [...new Set(classification.matchedIds.map(String))];
    const next = { ...saved, pullRequests: [...inventory.values()], matchedIds, pendingIds: [...pending],
      updatedAt: new Date().toISOString() };
    await writeRunnerJsonAsync(file, next);
    if (allowBootstrap) await fs.unlink(`${file}.bootstrap.json`).catch(() => {});
    return { pullRequests: current, matchedIds, classification, cursor: next.updatedAt,
      metrics: { ...metrics, inventorySize: inventory.size, pendingRefreshes: pending.size,
        catchingUp: Boolean(next.createdWindow || next.pushWindow), watchedCandidates: watches.length,
        lastReconciledAt: next.lastReconciledAt || null,
        reconcileFrom: next.reconcile.from, reconcileThrough: next.reconcile.through } };
  } finally { await release(); }
}
