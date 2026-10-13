import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { withAdmission } from "../../bridge/admission.mjs";
import { readJson, samePath } from "../../bridge/spool-store.mjs";
import { samePrUrl } from "../../bridge/creator-routing.mjs";
import { assertProseOnly, reviewerRules, roles, routing } from "./plan.mjs";

const policy = ".azuredevops/policies/branchpolicies/master/requiredReviewers.yml";
const normalize = text => text.replace(/\r\n/g, "\n");
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8",
  windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const contents = (root, revision, file) => execFileSync("git", ["show", `${revision}:${file}`], {
  cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"] });

export async function updateSpellingPr({ store, config, state, fingerprint, batch, report, save,
  get, call, publishCall, metadata, support, now }) {
  const root = config.publicationRoot, agent = config.publishAgent;
  if (!/^[a-f0-9]{40}$/.test(state.head || "") || !Array.isArray(state.files) || !state.files.length) {
    throw new Error("Existing spelling PR has an incomplete publication receipt");
  }
  const receipt = readJson(path.join(store.records, "native-creators", `${state.ownerId}.json`));
  if (!receipt?.verified || receipt.taskId !== state.ownerId || receipt.agent !== agent ||
      receipt.originKind !== "spool_automation" || receipt.branch !== state.branch ||
      String(receipt.prId) !== String(state.prId) || !samePrUrl(receipt.prUrl, state.prUrl) ||
      !samePath(receipt.workspace, root)) throw new Error("Existing spelling PR ownership is not verified; update held");
  const snapshot = async allowedHeads => {
    const pr = await get(config.ado, state.prId, { refresh: true });
    if (!pr || pr.branch !== state.branch || !samePrUrl(pr.url, state.prUrl)) {
      throw new Error("Existing spelling PR identity changed; update held");
    }
    if (["completed", "abandoned"].includes(pr.status)) {
      state.remoteStatus = pr.status;
      state.closedFingerprint = state.refresh?.fingerprint || batch.fingerprint;
      save(); return null;
    }
    if (pr.status !== "active" || !allowedHeads.includes(pr.sourceCommit)) {
      throw new Error("Existing spelling PR has unverified newer work; update held");
    }
    return pr;
  };
  if (!await snapshot([state.head, state.refresh?.head].filter(Boolean))) return { closed: 1 };
  if (!state.refresh && (state.fingerprint || fingerprint) === batch.fingerprint) return { existing: 1 };
  if (!state.refresh && state.files.length === batch.files.length && batch.files.every(file =>
    state.files.includes(file.file) && normalize(contents(root, state.head, file.file)) === normalize(file.after))) {
    state.fingerprint = batch.fingerprint; save(); return { existing: 1 };
  }
  const result = await withAdmission(store.root, agent, async () => {
    store.assertIdle(agent, root); support(store);
    if (!await snapshot([state.head, state.refresh?.head].filter(Boolean))) return { closed: 1 };
    if (state.refresh && state.refresh.fingerprint !== batch.fingerprint) {
      throw new Error("A different spelling refresh has unfinished work; update held");
    }
    if (!state.refresh) {
      if (git(root, "status", "--porcelain")) throw new Error("Uncommitted work blocks spelling refresh");
      const prepared = await call("bohemia_prepare", { repoRoot: root, operation: "branch",
        mode: "checkout", branch: state.branch, expectedHead: state.head, mergeMaster: true,
        reset: false, runSetup: true, runBuild: false });
      if (!prepared.ready || !samePath(prepared.repoRoot, root) || prepared.branch !== state.branch ||
          prepared.commit !== git(root, "rev-parse", "HEAD") || git(root, "status", "--porcelain") ||
          git(root, "rev-parse", "origin/master") !== report.commit) {
        throw new Error("Existing PR preparation differs from the scanned master; update held");
      }
      git(root, "merge-base", "--is-ancestor", state.head, prepared.commit);
      git(root, "merge-base", "--is-ancestor", report.commit, prepared.commit);
      state.refresh = { fingerprint: batch.fingerprint, preparedHead: prepared.commit,
        commit: report.commit, phase: "prepared", files: [...new Set([...state.files, ...batch.files.map(f => f.file)])] };
      save();
    }
    const refresh = state.refresh;
    if (git(root, "branch", "--show-current") !== state.branch || refresh.commit !== report.commit) {
      throw new Error("Pending spelling refresh changed branch or source; work preserved");
    }
    const rules = reviewerRules(contents(root, report.commit, policy));
    const targets = new Map(batch.files.map(file => [file.file, file.after]));
    for (const file of refresh.files) {
      if (file.includes("\\") || file.split("/").includes("..") || !/^(packages|apps)\/[^/]+\//.test(file)) {
        throw new Error("Unsafe existing spelling publication path");
      }
      const owners = routing(file, rules);
      for (const role of roles) {
        if (owners[role].some(owner => !batch.files.some(f => f.reviewers[role].includes(owner)))) {
          throw new Error("Existing spelling files changed reviewer ownership; update held");
        }
      }
      if (!targets.has(file)) targets.set(file, contents(root, report.commit, file));
      assertProseOnly(file, contents(root, report.commit, file), targets.get(file));
    }
    const assertFiles = () => {
      if (git(root, "ls-files", "--others", "--exclude-standard")) throw new Error("Untracked work blocks spelling refresh");
      for (const file of git(root, "diff", "--name-only", report.commit).split("\n").filter(Boolean)) {
        if (targets.has(file)) {
          assertProseOnly(file, contents(root, report.commit, file), readFileSync(path.join(root, file), "utf8"));
        } else if (file.startsWith("change/")) {
          const change = JSON.parse(readFileSync(path.join(root, file), "utf8"));
          if (change.type !== "none" || change.dependentChangeType !== "none") {
            throw new Error("Spelling refresh contains a release bump");
          }
          for (const role of roles) for (const owner of routing(file, rules)[role]) {
            if (!batch.files.some(f => f.reviewers[role].includes(owner))) {
              throw new Error("Spelling metadata adds reviewer ownership");
            }
          }
        } else throw new Error("Existing spelling PR contains unrelated work; update held");
      }
    };
    assertFiles();
    if (refresh.phase === "prepared") {
      const head = git(root, "rev-parse", "HEAD");
      if (head !== refresh.preparedHead) {
        if (git(root, "rev-parse", "HEAD^") !== refresh.preparedHead || git(root, "status", "--porcelain")) {
          throw new Error("Unrecognized spelling refresh commit; work preserved");
        }
        for (const [file, after] of targets) assert.equal(normalize(contents(root, head, file)), normalize(after));
      } else {
        if (git(root, "diff", "--cached", "--name-only") ||
            git(root, "diff", "--name-only").split("\n").filter(Boolean).some(file => !targets.has(file))) {
          throw new Error("Staged or unrelated work blocks spelling refresh");
        }
        for (const [file, after] of targets) {
          const current = readFileSync(path.join(root, file), "utf8");
          if (![contents(root, head, file), after].some(text => normalize(text) === normalize(current))) {
            throw new Error(`Authored edits block spelling refresh: ${file}`);
          }
        }
        for (const [file, after] of targets) {
          const destination = path.join(root, file), current = readFileSync(destination, "utf8");
          writeFileSync(destination, current.includes("\r\n") ? normalize(after).replace(/\n/g, "\r\n") : after);
        }
        git(root, "diff", "--check");
        if (git(root, "diff", "--name-only")) {
          git(root, "add", "--", ...targets.keys());
          git(root, "commit", "-m", `docs: refresh ${batch.area} spelling and grammar fixes`);
        }
      }
      refresh.head = git(root, "rev-parse", "HEAD"); refresh.phase = "committed"; save();
    }
    if (refresh.phase === "committed") {
      if (git(root, "status", "--porcelain")) throw new Error("Uncommitted work blocks spelling metadata");
      if (git(root, "rev-parse", "HEAD") === refresh.head) await metadata();
      else {
        git(root, "merge-base", "--is-ancestor", refresh.head, "HEAD");
        if (git(root, "diff", "--name-only", refresh.head, "HEAD").split("\n").some(file => !file.startsWith("change/"))) {
          throw new Error("Unrecognized spelling metadata commit; work preserved");
        }
      }
      assertFiles();
      refresh.head = git(root, "rev-parse", "HEAD"); refresh.phase = "metadata"; save();
    }
    for (const [file, after] of targets) {
      assert.equal(normalize(readFileSync(path.join(root, file), "utf8")), normalize(after),
        `Spelling refresh no longer matches the generated plan: ${file}`);
    }
    if (git(root, "rev-parse", "HEAD") !== refresh.head || git(root, "status", "--porcelain")) {
      throw new Error("Spelling refresh no longer has its exact clean commit");
    }
    if (refresh.phase === "metadata") {
      const checked = await call("bohemia_check", { repoRoot: root, baseBranch: "master" });
      if (!checked.ready || checked.commit !== refresh.head) throw new Error("Spelling refresh checks did not verify its commit");
      refresh.phase = "checked"; save();
    }
    if (!await snapshot([state.head, refresh.head])) return { closed: 1 };
    const currentRules = reviewerRules(contents(root, "origin/master", policy));
    for (const file of refresh.files) assert.deepEqual(routing(file, currentRules), routing(file, rules),
      "Reviewer policy changed before spelling refresh publication");
    await publishCall("bohemia_pr", { action: "update", repository: config.ado.repository,
      pullRequestId: Number(state.prId), notify: false }, { env: {
      BOHEMIA_CREATOR_CONTEXT: "", COPILOT_SESSION_ID: "", SPOOL_PROVIDER_TOKEN: "",
      BOHEMIA_PR_MCP_SEARCH_ROOTS: root,
    } });
    if (!await snapshot([refresh.head])) return { closed: 1 };
    Object.assign(state, { head: refresh.head, commit: report.commit, files: refresh.files,
      fingerprint: batch.fingerprint, scannerVersion: report.scannerVersion, updatedAt: now().toISOString() });
    delete state.refresh; save();
    return { updated: 1 };
  }, root);
  if (result?.holding) throw new Error(`Spelling update held: ${result.holding}`);
  return result;
}
