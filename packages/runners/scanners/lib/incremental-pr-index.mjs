import fs from "node:fs/promises";
import path from "node:path";
import {
  acquireProcessLock, writeRunnerJsonAsync,
} from "../../packages/bohemia-agent-tooling/src/index.js";

const sha = /^[a-f0-9]{40}$/i;
const idOf = pr => String(pr?.pullRequestId || "");
const validId = id => /^[1-9]\d*$/.test(String(id)) && Number.isSafeInteger(Number(id));

export async function syncPullRequestIndex({
  file, identity, repository, project, readEvents, loadSnapshot, readPullRequest, readRef,
  include = () => true, allowBootstrap = false,
}) {
  if (!path.isAbsolute(file) || !identity || !repository || !project)
    throw new Error("Incremental PR index requires explicit scope and storage identities");
  const canonical = process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  const release = await acquireProcessLock(canonical, { namespace: "repository-pr-index", timeoutMs: 120000 });
  try {
    let saved;
    try { saved = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (saved && (saved.version !== 1 || saved.identity !== identity || saved.repository !== repository ||
        saved.project !== project || !Number.isSafeInteger(saved.cursor) || saved.cursor < 0 ||
        !Array.isArray(saved.pullRequests)))
      throw new Error("Incremental PR index does not match its authorization and query scope");
    const metrics = { bootstrapRequests: 0, changedPullRequests: 0, targetRefs: 0, eventPages: 0 };
    const validate = pr => {
      if (!validId(idOf(pr)) || pr?.repository?.id?.toLowerCase() !== repository.toLowerCase() ||
          !["active", "completed", "abandoned"].includes(pr.status) ||
          (pr.status === "active" && (!sha.test(pr.lastMergeSourceCommit?.commitId || "") ||
            !sha.test(pr.lastMergeTargetCommit?.commitId || "") ||
            typeof pr.sourceRefName !== "string" || typeof pr.targetRefName !== "string")))
        throw new Error("Invalid pinned PR metadata in incremental inventory");
      return pr;
    };
    const checkPage = (page, after, journal, through) => {
      if (!page || page.repository !== repository || page.project !== project ||
          typeof page.journal !== "string" || !page.journal || (journal && page.journal !== journal) ||
          !Number.isSafeInteger(page.head) || page.head < after ||
          (through !== undefined && page.head !== through) || !Array.isArray(page.events))
        throw new Error("Event journal changed identity or lost checkpoint history");
      let previous = after;
      for (const event of page.events) {
        if (!Number.isSafeInteger(event.sequence) || event.sequence <= previous || event.sequence > page.head ||
            !Array.isArray(event.refUpdates) ||
            !(event.pullRequestId === null || validId(event.pullRequestId)) ||
            event.refUpdates.some(ref => typeof ref.name !== "string" || !ref.name.startsWith("refs/") ||
              !sha.test(ref.newObjectId || "")))
          throw new Error("Invalid ordered repository event page");
        previous = event.sequence;
      }
      if (page.head > after && !page.events.length)
        throw new Error("Incomplete event history; refusing a full-inventory fallback");
      return page;
    };
    let page = checkPage(await readEvents(saved?.cursor || 0), saved?.cursor || 0, saved?.journal);
    metrics.eventPages++;
    if (!saved) {
      if (!allowBootstrap) throw new Error("Initial PR inventory requires an explicit bootstrap, not a polling fallback");
      const cursor = page.head;
      const initial = await loadSnapshot();
      metrics.bootstrapRequests++;
      if (initial?.complete !== true || !Array.isArray(initial.pullRequests))
        throw new Error("Initial PR inventory is incomplete");
      initial.pullRequests.forEach(validate);
      saved = { version: 1, identity, repository, project, journal: page.journal, cursor,
        pullRequests: initial.pullRequests };
      page = checkPage(await readEvents(cursor), cursor, saved.journal);
      metrics.eventPages++;
    }
    saved.pullRequests.forEach(validate);
    const inventory = new Map(saved.pullRequests.map(pr => [idOf(pr), pr]));
    if (inventory.size !== saved.pullRequests.length) throw new Error("Duplicate PR identities in index");
    const fence = page.head;
    let cursor = saved.cursor;
    const dirtyRefs = new Set(), dirtyIds = new Set();
    for (;;) {
      for (const event of page.events) {
        if (event.pullRequestId !== null) dirtyIds.add(String(event.pullRequestId));
        for (const ref of event.refUpdates) dirtyRefs.add(ref.name);
      }
      cursor = page.events.at(-1)?.sequence ?? cursor;
      if (cursor >= fence) break;
      page = checkPage(await readEvents(cursor, fence), cursor, saved.journal, fence);
      metrics.eventPages++;
    }
    for (const pr of inventory.values())
      if (dirtyRefs.has(pr.sourceRefName)) dirtyIds.add(idOf(pr));
    // Fetch current metadata, not event payloads: delayed/duplicate notifications cannot roll heads back.
    for (const id of dirtyIds) {
      const pr = validate(await readPullRequest(id));
      if (idOf(pr) !== id) throw new Error("Changed PR lookup returned another identity");
      inventory.set(id, pr);
      metrics.changedPullRequests++;
    }
    for (const ref of dirtyRefs) {
      const affected = [...inventory.values()].filter(pr => pr.status === "active" && pr.targetRefName === ref);
      if (!affected.length) continue;
      const commit = await readRef(ref);
      if (!sha.test(commit || "") || /^0+$/.test(commit)) throw new Error("Changed target reference is unavailable");
      for (const pr of affected) inventory.set(idOf(pr), { ...pr, lastMergeTargetCommit: { commitId: commit } });
      metrics.targetRefs++;
    }
    const pullRequests = [...inventory.values()].filter(pr => pr.status === "active" && include(pr));
    const next = { ...saved, cursor, pullRequests, updatedAt: new Date().toISOString() };
    await writeRunnerJsonAsync(file, next);
    return { pullRequests, cursor, metrics };
  } finally { await release(); }
}
