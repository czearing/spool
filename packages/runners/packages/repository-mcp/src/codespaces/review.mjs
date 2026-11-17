import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { token } from "../../../bohemia-pr-mcp/src/ado.ts";
import { writeReceipt } from "../process.mjs";
import { execute } from "../process.mjs";
import { assertReviewIdentity, assertReviewCoverage, readCodespaceConfig, shellQuote } from "./config.mjs";
import { CodespaceTransport } from "./transport.mjs";
import { verifyEngineeringCodespace } from "./engineering.mjs";
import { codespaceConnectionFailure } from "./github-requests.mjs";
import { reviewRevisionChange, reviewRevisionUpdate, supersededReviewError } from "../review-outcome.mjs";

const base = "https://dev.azure.com/office/Office/_apis/git/repositories/1JS";
export async function adoJson(suffix, fetcher = fetch, accessToken = token) {
  const response = await fetcher(`${base}${suffix}${suffix.includes("?") ? "&" : "?"}api-version=7.1`, {
    headers: { Authorization: `Bearer ${await accessToken()}` }, redirect: "error",
  });
  if (!response.ok || !(response.headers.get("content-type") || "").includes("json"))
    throw new Error(`1JS Azure DevOps request failed: HTTP ${response.status}`);
  return response.json();
}

export async function readReviewPullRequest(id, read = adoJson) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("A positive PR id is required");
  const pr = await read(`/pullrequests/${id}`);
  const result = { id, sourceCommit: pr.lastMergeSourceCommit?.commitId,
    targetCommit: pr.lastMergeTargetCommit?.commitId, sourceBranch: pr.sourceRefName,
    status: pr.status, isDraft: pr.isDraft === true, title: pr.title };
  assertReviewIdentity(result);
  if (result.status !== "active" || result.isDraft) throw new Error("Only an active non-draft PR can be prepared for review");
  return result;
}

export async function changedReviewFiles(pr, read, readFiles) {
  const comparison = await read(`/diffs/commits?baseVersion=${pr.targetCommit}&baseVersionType=commit` +
    `&targetVersion=${pr.sourceCommit}&targetVersionType=commit&diffCommonCommit=true&$top=0`);
  if (!/^[a-f0-9]{40}$/i.test(comparison.commonCommit || "") ||
      comparison.baseCommit !== pr.targetCommit || comparison.targetCommit !== pr.sourceCommit ||
      comparison.changes !== undefined && (!Array.isArray(comparison.changes) || comparison.changes.length))
    throw new Error("Azure DevOps did not return the pinned comparison identities");
  const files = await readFiles(comparison.commonCommit, pr.sourceCommit);
  assertReviewCoverage(files);
  return { commonCommit: comparison.commonCommit, files: [...new Set(files)].sort() };
}

export function assertFreshReview(expected, actual) {
  const supersession = reviewRevisionChange(expected, actual);
  if (supersession) throw supersededReviewError(supersession);
  if (actual.id !== expected.id || actual.sourceCommit !== expected.sourceCommit ||
      actual.targetCommit !== expected.targetCommit || actual.sourceBranch !== expected.sourceBranch ||
      actual.status !== "active" || actual.isDraft)
    throw new Error("PR source, target or eligibility changed during preparation; reviewer handoff blocked");
}

export class CodespaceReview {
  constructor(configFile, dependencies = {}) {
    this.config = dependencies.config || readCodespaceConfig(configFile);
    this.transport = dependencies.transport || new CodespaceTransport(this.config);
    let cachedToken;
    this.accessToken = async () => {
      if (this.useOwnedAuthentication) return this.transport.reviewAccessToken();
      if (cachedToken && cachedToken.expires > Date.now() + 120000) return cachedToken.value;
      const command = process.platform === "win32" ? "cmd.exe" : "az";
      const args = [...(process.platform === "win32" ? ["/d", "/c", "az"] : []),
        "account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798", "-o", "json"];
      const { stdout } = await execute(command, args, { env: { ...process.env,
        PATH: [this.config.azureCliDirectory, process.env.PATH].join(path.delimiter) } });
      const result = JSON.parse(stdout);
      if (!result.accessToken || !Number.isFinite(Number(result.expires_on)) ||
          Number(result.expires_on) * 1000 <= Date.now())
        throw new Error("Repository authentication did not return a valid expiring ADO credential");
      cachedToken = { value: result.accessToken, expires: Number(result.expires_on) * 1000 };
      return cachedToken.value;
    };
    const read = suffix => adoJson(suffix, fetch, this.accessToken);
    this.readPr = dependencies.readPr || (id => readReviewPullRequest(id, read));
    this.changes = dependencies.changes || (pr => changedReviewFiles(pr, read,
      (common, source) => this.transport.changedReviewFiles(common, source)));
    this.readSourceRef = dependencies.readSourceRef || (async branch => {
      const refs = await read(`/refs?filter=${encodeURIComponent(branch.replace(/^refs\//, ""))}`);
      return refs.value?.find(ref => ref.name === branch)?.objectId;
    });
    this.disposed = false;
    this.receiptFile = path.join(this.config.workspace, "preparation.json");
  }
  save(value) {
    this.receipt = { ...this.receipt, ...value, updatedAt: new Date().toISOString() };
    writeReceipt(this.receiptFile, this.receipt);
    return this.receipt;
  }
  async prepare({ prId, sourceCommit, repoRoot = this.config.workspace }) {
    if (fs.realpathSync(repoRoot) !== this.config.workspace) throw new Error("Reviewer local workspace is not registered");
    this.save({ ready: false, status: "preparing", prId, repoRoot: this.config.workspace, codespace: this.config.codespace });
    try {
      const pr = await this.readPr(Number(prId));
      if (sourceCommit && pr.sourceCommit !== sourceCommit) throw new Error("Queued PR source revision is stale");
      this.save({ pr, commit: pr.sourceCommit, sourceCommit: pr.sourceCommit,
        branch: `review/pr-${pr.id}-${pr.sourceCommit.slice(0, 12)}`,
        configSha256: createHash("sha256").update(fs.readFileSync(this.config.file)).digest("hex") });
      this.save({ stage: "connection" });
      await this.transport.initialize();
      this.save({ leaseToken: this.transport.leaseToken });
      this.save({ stage: "tool-deployment" });
      await this.transport.deploy();
      await this.verifySourceRef();
      this.save({ stage: "changed-file-inventory" });
      const comparison = await this.changes(pr);
      this.save({ comparison, stage: "exact-revision-setup-and-build" });
      const prepared = await this.transport.native("prepare", { repoRoot: this.config.remoteRoot,
        operation: "branch", mode: "checkout", branch: this.receipt.branch,
        sourceCommit: pr.sourceCommit, reset: true, mergeMaster: false,
        runSetup: true, runBuild: true, minimumFreeGiB: this.config.minimumFreeGiB }, comparison.files);
      if (!prepared.ready || prepared.commit !== pr.sourceCommit ||
          prepared.branch !== this.receipt.branch)
        throw new Error("Remote preparation did not verify the exact requested revision");
      if (prepared.preparationKind !== "repository-prepare")
        throw new Error("Review setup must use canonical repository preparation");
      this.save({ packagePreparation: prepared, preparationKind: "repository-prepare", stage: "handoff-verification" });
      await this.verify();
      const result = this.save({ version: 1, ready: true, status: "ready", ownerPid: process.pid,
        execution: { kind: "codespace", configFile: this.config.file, codespace: this.config.codespace,
          nativeRepoRoot: this.config.remoteRoot, receiptFile: this.receiptFile,
          command: fileURLToPath(new URL("./run.mjs", import.meta.url)) } });
      for (const child of this.transport.children || []) child.once("exit", () => {
        if (!this.disposed) this.save({ ready: false, status: "blocked", error: `Remote repository connection exited; log: ${child.logFile}` });
      });
      return result;
    } catch (error) {
      this.save({ ready: false, status: "blocked", error: error.message });
      await this.dispose(false);
      throw Object.assign(new Error(`${error.message}; receipt: ${this.receiptFile}`, { cause: error }),
        error.code === "review_superseded" ? {
          code: error.code, stage: error.stage, reviewOutcome: error.reviewOutcome, nextAction: error.nextAction,
        } : {});
    }
  }
  async verify({ allowRevisionDrift = false } = {}) {
    this.transport.assertChildren();
    await this.transport.verifyLease(this.receipt.leaseToken);
    const fresh = await this.readPr(this.receipt.pr.id);
    if (allowRevisionDrift) {
      assertReviewIdentity(fresh);
      if (fresh.id !== this.receipt.pr.id || fresh.sourceBranch !== this.receipt.pr.sourceBranch ||
          fresh.status !== "active" || fresh.isDraft)
        throw new Error("Review PR identity or eligibility changed");
      const revisionUpdate = reviewRevisionUpdate(this.receipt.pr, fresh);
      if (revisionUpdate || this.receipt.revisionUpdate) this.save({ revisionUpdate });
    } else if (this.config.repositoryReview === true && fresh.targetCommit !== this.receipt.pr.targetCommit) {
      assertFreshReview({ ...this.receipt.pr, targetCommit: fresh.targetCommit }, fresh);
      const comparison = await this.changes(fresh);
      if (comparison.commonCommit !== this.receipt.comparison.commonCommit ||
          JSON.stringify(comparison.files) !== JSON.stringify(this.receipt.comparison.files))
        throw new Error("PR comparison changed with the target branch; reprepare the review");
      this.save({ pr: fresh, comparison, targetRevalidation: {
        verifiedAt: new Date().toISOString(), unchangedDiff: true,
      } });
    } else assertFreshReview(this.receipt.pr, fresh);
    if (!allowRevisionDrift) await this.verifySourceRef();
    const { stdout } = await this.transport.ssh(`cd ${shellQuote(this.config.remoteRoot)}\n` +
      `git rev-parse HEAD\ngit symbolic-ref --short HEAD`);
    const [head, branch] = stdout.trim().split(/\r?\n/);
    if (head !== this.receipt.commit || branch !== this.receipt.branch)
      throw new Error("Remote revision changed; handoff blocked");
    return true;
  }
  async verifySourceRef() {
    if (this.config.repositoryReview === true) {
      if (await this.readSourceRef(this.receipt.pr.sourceBranch) !== this.receipt.commit)
        throw new Error("PR source branch moved or is unavailable; exact-revision handoff blocked");
      return;
    }
    const { stdout } = await this.transport.ssh(`git -C ${shellQuote(this.config.remoteRoot)} ` +
      `ls-remote --heads --exit-code origin ${shellQuote(this.receipt.pr.sourceBranch)}`);
    if (stdout.trim().split(/\s+/)[0] !== this.receipt.commit)
      throw new Error("PR source branch moved or is unavailable; exact-revision handoff blocked");
  }
  async dispose(markStopped = true) {
    if (this.disposed) return;
    this.disposed = true;
    await this.transport.dispose();
    if (markStopped && this.receipt?.status === "ready") this.save({ ready: false, status: "stopped" });
  }
}

export function assertPreparationEvidence(saved, config) {
  if (saved.version !== 1 || saved.preparationKind !== "repository-prepare" ||
      saved.packagePreparation?.preparationKind !== "repository-prepare" || saved.packagePreparation.ready !== true ||
      typeof saved.packagePreparation.buildWarmed !== "boolean" ||
      saved.packagePreparation.commit !== saved.commit ||
      saved.packagePreparation.branch !== saved.branch ||
      config && saved.packagePreparation.repoRoot !== config.remoteRoot ||
      saved.pr?.sourceCommit !== saved.commit || saved.sourceCommit !== saved.commit)
    throw new Error("Saved Codespace preparation lacks exact-revision repository preparation evidence");
}

export async function verifySavedCodespace(prepared, { allowDirty = false, transport, allowRevisionDrift = false } = {}) {
  if (!prepared?.ready || prepared.status !== "ready" || prepared.execution?.kind !== "codespace")
    throw new Error("Codespace preparation is not ready; finish the runner's repository setup and build first");
  const config = readCodespaceConfig(prepared.execution?.configFile || "");
  if (config.purpose === "engineering") return verifyEngineeringCodespace(prepared, { config, allowDirty });
  if (allowDirty) throw new Error("Codespace review does not support mutation/publication workflows");
  const saved = JSON.parse(fs.readFileSync(path.join(config.workspace, "preparation.json"), "utf8"));
  if (!saved.ready || saved.status !== "ready" || saved.commit !== prepared.commit ||
      saved.branch !== prepared.branch || saved.pr?.id !== prepared.pr?.id ||
      saved.codespace !== config.codespace || saved.leaseToken !== prepared.leaseToken || prepared.repoRoot !== config.workspace ||
      saved.configSha256 !== createHash("sha256").update(fs.readFileSync(config.file)).digest("hex"))
    throw new Error("Remote preparation is stopped, changed or unverified; prepare the existing task again");
  assertPreparationEvidence(saved, config);
  const session = new CodespaceReview(config.file, { config, ...(transport ? { transport } : {}) });
  session.receipt = saved;
  session.useOwnedAuthentication = true;
  try {
    if (!session.transport.env) await session.transport.environment();
    await session.verify({ allowRevisionDrift });
    return session.receipt.revisionUpdate || null;
  }
  catch (error) {
    if (!codespaceConnectionFailure(error))
      session.save({ ready: false, status: "blocked", stage: "revalidation", error: error.message });
    throw error;
  }
}
