import { execFileSync } from "node:child_process";
import path from "node:path";
import { readJson, writeJson, samePath } from "./spool-store.mjs";
import { ciJobContext, readCiJob, withCiJobLock } from "./ci-job.mjs";
import { getPullRequest, requeuePolicy } from "../scanners/pr-updater/lib/azure-devops.mjs";
import { policyUrl } from "../scanners/pr-updater/lib/build-evidence.mjs";
import { accessToken, getJson, requestJson } from "../scanners/pr-updater/lib/ado-transport.mjs";
import { prReviewFingerprint } from "../packages/bohemia-pr-mcp/src/pr-origin.mjs";
import { publicationForTask } from "./publications.mjs";

export async function listCiPolicies(config, prId) {
  const url = new URL(policyUrl(config, prId));
  url.searchParams.set("includeNotApplicable", "true");
  url.searchParams.set("$top", "100");
  const rows = [];
  for (let skip = 0; ; skip += 100) {
    url.searchParams.set("$skip", String(skip));
    const payload = await getJson(url.href, accessToken(), fetch, true);
    if (!Array.isArray(payload.value)) throw new Error("Invalid CI policy response");
    rows.push(...payload.value);
    if (payload.value.length < 100) return rows;
  }
}
async function abandonCiDraft(config, prId) {
  const url = `${config.organization}/${encodeURIComponent(config.project)}/_apis/git/repositories/${encodeURIComponent(config.repository)}/pullRequests/${prId}?api-version=7.1`;
  await requestJson(url, { method: "PATCH", token: accessToken(), fetchImpl: fetch,
    metric: "PATCH rejected CI draft", body: { status: "abandoned" } });
}
async function publishCiDraft(config, prId) {
  const url = `${config.organization}/${encodeURIComponent(config.project)}/_apis/git/repositories/${encodeURIComponent(config.repository)}/pullRequests/${prId}?api-version=7.1`;
  await requestJson(url, { method: "PATCH", token: accessToken(), fetchImpl: fetch,
    metric: "PATCH accepted CI draft", body: { isDraft: false } });
}
async function ownedDraft({ store, taskId, config, getPullRequest: get = getPullRequest, allowReady = false }) {
  const { task, metadata } = ciJobContext(store, taskId);
  const owner = publicationForTask(store, taskId, { branch: metadata.preparation.branch });
  if (!owner) return null;
  if (!owner.verified || owner.agent !== "ci" || owner.taskId !== taskId || !task.session_id ||
      owner.sessionId !== task.session_id || !owner.targetBranch ||
      !samePath(owner.workspace, task.workspace) || owner.branch !== metadata.preparation.branch)
    throw new Error("CI draft does not retain its original owner and prepared checkout");
  const publication = owner.publications?.at(-1);
  if (!publication?.checked || (publication.draft !== true && !(allowReady && publication.draft === false)) ||
      !/^[a-f0-9]{64}$/i.test(publication.reviewHash || "") || !/^[a-f0-9]{40}$/i.test(publication.head || ""))
    throw new Error("CI draft has no checked original-owner publication receipt");
  const pr = await get(config.ado, owner.prId, { refresh: true });
  if (pr.id !== owner.prId || pr.branch !== owner.branch || pr.sourceCommit !== publication.head ||
      owner.originKind !== "mcp" && !pr.description.startsWith(`<!-- bohemia-origin:${owner.originId} -->`) ||
      pr.targetBranch !== owner.targetBranch || publication.reviewHash !== prReviewFingerprint(pr))
    throw new Error("CI draft changed from its checked original publication; cleanup and validation held");
  return { owner, pr, head: publication.head };
}
export async function queueCiValidation(options) {
  const { store, taskId, config, listPolicies = listCiPolicies, requeue = requeuePolicy, repeat = false, readOnly = false } = options;
  return withCiJobLock(store, taskId, async () => {
    if (store.isPaused("ci")) throw new Error("CI is paused; draft validation held");
    const binding = await ownedDraft({ ...options, allowReady: readOnly });
    if (!binding) return { passed: false, holding: "CI candidate draft has not been published" };
    const { pr, head } = binding;
    if (pr.status !== "active" || (!pr.isDraft && !readOnly)) throw new Error("CI validation requires an active original draft");
    const policies = (await listPolicies(config.ado, pr.id)).filter(row =>
      row.configuration?.isEnabled === true && row.configuration.isBlocking === true &&
      Number.isSafeInteger(row.configuration.settings?.buildDefinitionId));
    if (!policies.length) throw new Error("CI draft has no required build policies; validation cannot be claimed");
    const currentBuild = row => row.context?.lastMergeSourceCommitId === head &&
      (!row.context?.buildIsNotCurrent || row.configuration.settings.queueOnSourceUpdateOnly === true) &&
      !row.context?.isExpired && row.context?.buildId;
    const summary = () => ({ head, prId: pr.id, policies: policies.map(row => ({
      id: row.evaluationId, status: row.status, buildId: row.context?.buildId,
    })) });
    if (readOnly) {
      if (repeat) throw new Error("Read-only CI verification cannot request repeat builds");
      const fresh = await ownedDraft({ ...options, allowReady: true });
      if (fresh?.head !== head || fresh.pr.status !== "active")
        throw new Error("CI publication changed during outcome verification");
      return { passed: policies.every(row => row.evaluationId && currentBuild(row) && row.status === "approved"), ...summary() };
    }
    const file = path.join(store.records, "ci-validations", `${taskId}.json`);
    const ledger = readJson(file) || { version: 1, taskId, requests: {} };
    if (ledger.version !== 1 || ledger.taskId !== taskId || !ledger.requests)
      throw new Error("Invalid CI validation request ledger");
    if (repeat && policies.some(row => ["running", "queued"].includes(row.status) && row.context?.buildId))
      throw new Error("Do not replace a running CI validation");
    let passed = true;
    for (const row of policies) {
      if (!row.evaluationId) throw new Error("CI build policy lacks its evaluation identity");
      const current = currentBuild(row);
      const key = `${head}:${pr.targetCommit || ""}:${row.evaluationId}`;
      let request = ledger.requests[key];
      if (request && row.context?.buildId === request.previousBuildId) {
        passed = false;
        if (request.phase === "pending") throw new Error("CI validation request outcome is uncertain; reconcile the original request");
        if (repeat) throw new Error("Await the new CI validation build before requesting another sample");
        continue;
      }
      if (current && ["running", "queued", "approved", "rejected"].includes(row.status) && !repeat) {
        passed &&= row.status === "approved";
        if (request?.phase === "pending") {
          ledger.requests[key] = { ...request, phase: "observed", buildId: row.context.buildId };
          writeJson(file, ledger);
        }
        continue;
      }
      passed = false;
      if (request && !repeat) {
        if (request.phase === "pending") throw new Error("CI validation request outcome is uncertain; reconcile the original request");
        continue;
      }
      if (["running", "queued"].includes(row.status) && row.context?.buildId)
        throw new Error("A running build does not prove the current CI head; do not cancel it");
      const attempts = (request?.attempts || 0) + 1;
      const dispatched = Object.values(ledger.requests).filter(value =>
        value.head === head && value.evaluationId === row.evaluationId)
        .reduce((total, value) => total + value.attempts, 0);
      if (dispatched >= 3) throw new Error("CI validation reached its three-sample budget for this head");
      const before = await ownedDraft(options);
      if (before?.head !== head || before.pr.status !== "active" || !before.pr.isDraft)
        throw new Error("CI draft changed before validation dispatch");
      request = { head, evaluationId: row.evaluationId, attempts, phase: "pending",
        previousBuildId: row.context?.buildId || null };
      ledger.requests[key] = request; writeJson(file, ledger);
      await requeue(config.ado, row.evaluationId, { prId: pr.id });
      const after = await ownedDraft(options);
      if (after?.head !== head || after.pr.status !== "active" || !after.pr.isDraft)
        throw new Error("CI draft changed during validation dispatch");
      ledger.requests[key] = { ...request, phase: "requested" }; writeJson(file, ledger);
    }
    return { passed, ...summary() };
  });
}
export async function publishAcceptedCiExperiment(options) {
  const { store, taskId, config, publish = publishCiDraft } = options;
  const validation = await queueCiValidation({ ...options, readOnly: true, repeat: false });
  if (!validation.passed) throw new Error("Accepted CI publication requires passing current-source required checks");
  return withCiJobLock(store, taskId, async () => {
    const job = readCiJob(store, taskId), task = store.task(taskId);
    if (job?.outcome?.verdict !== "accepted" || job.outcome.head !== validation.head)
      throw new Error("Only the accepted original CI outcome may publish its checked PR");
    const binding = await ownedDraft({ ...options, allowReady: true });
    if (binding?.head !== validation.head || binding.pr.status !== "active")
      throw new Error("Accepted CI publication changed before readiness verification");
    const result = { prId: binding.pr.id, head: binding.head, readyForReview: true };
    if (!binding.pr.isDraft) return result;
    if (task.status !== "in_progress" || store.isPaused("ci") || task.interaction?.cancel_requested ||
        task.interaction?.paused || task.interaction?.status_change)
      throw new Error("CI publication held: original execution is inactive, paused, or interrupted");
    await publish(config.ado, binding.pr.id);
    const fresh = await ownedDraft({ ...options, allowReady: true });
    if (fresh?.head !== validation.head || fresh.pr.status !== "active" || fresh.pr.isDraft)
      throw new Error("Accepted CI PR readiness was not verified");
    return result;
  });
}
const cleanWorkspace = workspace => execFileSync("git", ["status", "--porcelain=v1"], {
  cwd: workspace, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
}).trim() === "";
export async function reconcileCiExperiment(options) {
  const { store, taskId, config, abandon = abandonCiDraft, cleanWorkspace: clean = cleanWorkspace } = options;
  const { task } = ciJobContext(store, taskId);
  const job = readCiJob(store, taskId);
  if (task.withdrawn || store.metadata(taskId)?.cancelled || task.interaction?.cancel_requested ||
      task.interaction?.paused || task.interaction?.status_change || task.error === "Marked failed by operator")
    return { holding: "Original CI task was interrupted or disposed by operator" };
  if (task.status === "in_progress" || task.status === "incoming") return { holding: "Original CI task is still working" };
  if (store.liveTasks([task]).length) return { holding: "Original CI session is still running" };
  if (store.isPaused("ci")) return { holding: "CI is paused by operator" };
  if (!job?.outcome) return { holding: "Original CI task has no durable outcome; inspect it before releasing more work" };
  if (job.outcome.verdict === "blocked" || task.status === "cancelled")
    return { holding: "Original CI task is blocked or cancelled; continue it rather than churning replacements" };
  if (job.outcome.verdict === "accepted") {
    if (task.status === "completed") return { released: true };
    const holding = "Accepted CI evidence conflicts with failed task status";
    if (task.status !== "failed") return { holding };
    return withCiJobLock(store, taskId, async () => {
      const binding = await ownedDraft({ ...options, allowReady: true });
      if (!binding || binding.head !== job.outcome.head ||
          !["completed", "abandoned"].includes(binding.pr.status)) return { holding };
      const current = store.task(taskId);
      if (current?.status !== task.status || current.updated_at !== task.updated_at ||
          current.interaction?.cancel_requested || current.interaction?.paused || current.interaction?.status_change ||
          store.isPaused("ci") || store.liveTasks([current]).length)
        return { holding: "Original CI task changed during closure verification" };
      if (!clean(task.workspace)) return { holding: "Original CI checkout must be clean before releasing closed work" };
      store.assertIdle("ci", task.workspace);
      writeJson(ciJobContext(store, taskId).file, { ...job, closure: {
        status: binding.pr.status, prId: binding.pr.id, head: binding.head, verifiedAt: new Date().toISOString() } });
      return { released: true };
    });
  }
  if (job.outcome.verdict !== "rejected") throw new Error("Invalid CI outcome verdict; cleanup held");
  if (task.status !== "failed") return { holding: "Rejected CI evidence requires an explicit failed original task" };
  if (!clean(task.workspace)) return { holding: "Original CI checkout must be clean before replacing rejected work" };
  store.assertIdle("ci", task.workspace);
  return withCiJobLock(store, taskId, async () => {
    const binding = await ownedDraft(options);
    if (!binding) {
      const branches = await options.listPullRequests({ ...config.ado, creatorId: undefined }, {
        allPages: true, refresh: true, status: "all", sourceBranch: job.branch });
      if (branches.length) throw new Error("CI branch has an unverified PR; refusing cleanup or replacement");
      return { released: true };
    }
    const { pr, head } = binding;
    if (head !== job.outcome.head || !pr.isDraft || !["active", "abandoned"].includes(pr.status))
      throw new Error("Rejected CI draft is no longer the original checked draft");
    if (pr.status === "active") {
      const fresh = await ownedDraft(options);
      if (fresh?.head !== head || !fresh.pr.isDraft || fresh.pr.status !== "active")
        throw new Error("Original CI draft changed before abandonment");
      await abandon(config.ado, pr.id);
      const closed = await ownedDraft(options);
      if (closed?.pr.status !== "abandoned" || !closed.pr.isDraft || closed.head !== head)
        throw new Error("CI draft abandonment was not verified; replacement held");
    }
    writeJson(ciJobContext(store, taskId).file, { ...job, closure: {
      status: "abandoned", prId: pr.id, head, verifiedAt: new Date().toISOString() } });
    return { released: true };
  });
}
