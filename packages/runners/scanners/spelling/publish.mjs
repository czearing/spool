import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { callBohemia } from "../../packages/bohemia-pr-mcp/src/client.mjs";
import { readJson, writeJson, samePath } from "../../bridge/spool-store.mjs";
import { withAdmission } from "../../bridge/admission.mjs";
import { samePrUrl } from "../../bridge/creator-routing.mjs";
import { createAdoTransport } from "../lib/ado-transport.mjs";
import { getPullRequest, listOwnPullRequests } from "../pr-updater/lib/azure-devops.mjs";
import { createProseChecker, repositoryWords, scannerVersion } from "./check.mjs";
import { planBatches, reviewerRules, roles, routing, assertProseOnly, validatePlan } from "./plan.mjs";
import { updateSpellingPr } from "./update.mjs";
import { assertSubstantiveChanges } from "../../packages/bohemia-pr-mcp/src/pr-content.mjs";

export const publicationVersion = 3;
const policyPath = ".azuredevops/policies/branchpolicies/master/requiredReviewers.yml";
const fullPath = (root, file) => path.join(root, ...file.split("/"));
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8",
  windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const command = (root, executable, args) => execFileSync(executable, args, {
  cwd: root, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

export function assertNativeSupport(store, now = Date.now()) {
  const capability = readJson(path.join(store.root, "controls", "capabilities.json"));
  const age = now - Date.parse(capability?.updatedAt);
  if (capability?.deferredPrOwnersVersion !== 1 || capability.preparedMessageVersion !== 1 ||
      capability.interactive !== true || !Number.isFinite(age) || age < 0 || age > 15_000) {
    throw new Error("Automatic spelling PRs require a live Spool daemon with native deferred ownership");
  }
}

export async function resolveIdentities(rules, { transport = createAdoTransport(), organization }) {
  const org = new URL(organization).hostname.endsWith(".visualstudio.com") ?
    new URL(organization).hostname.split(".")[0] : new URL(organization).pathname.split("/").filter(Boolean)[0];
  if (!org || !/^[a-z0-9-]+$/i.test(org)) throw new Error("Invalid reviewer organization");
  const result = new Map();
  for (const alias of [...new Set(rules.flatMap(rule => roles.flatMap(role => rule[role])))]) {
    const qualified = alias.startsWith("[");
    const query = new URLSearchParams({ searchFilter: qualified ? "General" : "MailAddress",
      filterValue: qualified ? alias : `${alias}@microsoft.com`, queryMembership: "None", "api-version": "7.1" });
    const response = await transport.request(`https://${org}.vssps.visualstudio.com/_apis/identities?${query}`,
      { cacheMs: 0, metric: "GET spelling reviewer identity" });
    if (!Array.isArray(response.value)) throw new Error("Invalid reviewer identity service response");
    if (response.value.length !== 1 || typeof response.value[0].isContainer !== "boolean") {
      result.set(alias, { error: `Reviewer ${alias} has no unique group/individual identity`, matches: response.value.length });
      continue;
    }
    result.set(alias, { group: response.value[0].isContainer, displayName: response.value[0].providerDisplayName });
  }
  return result;
}

export function createSpellingPublisher({ store, config, runtime, call = callBohemia,
  publishCall = callBohemia, list = listOwnPullRequests, get = getPullRequest, identities = resolveIdentities,
  support = assertNativeSupport, reserve, execute = command, now = () => new Date() }) {
  const journalFile = path.join(runtime, "spelling-publications.json");
  const root = config.publicationRoot, agent = config.publishAgent;
  const metadata = () => execute(root, process.platform === "win32" ? "cmd.exe" : "pnpm",
    process.platform === "win32" ? ["/d", "/c", "pnpm", "run", "change", "--type", "none",
      "--message", "Correct comment spelling and grammar"] :
      ["run", "change", "--type", "none", "--message", "Correct comment spelling and grammar"]);
  reserve ??= ({ id, title, branch, commit }) => {
    const binary = path.join(store.root, "target", "release", process.platform === "win32" ? "spool.exe" : "spool");
    return JSON.parse(execute(store.root, binary, ["--root", store.root, "reserve-pr-owner", "--id", id,
      "--agent", agent, "--title", title, "--workspace", root, "--branch", branch, "--commit", commit]));
  };
  return async report => {
    support(store);
    store.validateAgent(agent);
    if (report.scannerVersion !== scannerVersion) throw new Error("Scanner policy changed; rescan before publishing saved corrections");
    if (!root || samePath(root, report.repo)) throw new Error("Spelling publication requires a separate assigned checkout");
    if (git(report.repo, "rev-parse", "HEAD") !== report.commit) throw new Error("Scanned checkout changed; stale corrections held");
    const rules = reviewerRules(readFileSync(fullPath(report.repo, policyPath), "utf8"));
    const resolved = await identities(rules, config.ado);
    const checker = await createProseChecker(repositoryWords(report.repo,
      git(report.repo, "ls-files", "-z").split("\0").filter(Boolean)));
    let plan;
    try {
      plan = await validatePlan(planBatches(report, { root: report.repo, rules, identities: resolved }), checker);
    } finally { await checker.dispose(); }
    writeJson(path.join(runtime, "spelling-publication-plan.json"), plan);
    const journal = readJson(journalFile) || { version: 1, batches: {} };
    if (journal.version !== 1 || !journal.batches) throw new Error("Unsupported spelling publication journal");
    const save = () => writeJson(journalFile, journal);
    const current = new Set(plan.batches.map(batch => batch.fingerprint));
    for (const [key, state] of Object.entries(journal.batches)) {
      if (!current.has(key) && !["published", "held"].includes(state.phase)) {
        state.previousPhase = state.phase; state.phase = "held";
        state.reason = "Persisted corrections are not in the current validated scanner plan; branch and commits preserved";
      }
    }
    save();
    const open = await list(config.ado, { status: "active", allPages: true, refresh: true });
    let created = 0, existing = 0, closed = 0, updated = 0;
    for (const batch of plan.batches) {
      const slug = batch.area.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const prefix = `user/calebzearing/spelling-${slug}-`;
      const key = batch.fingerprint;
      let state = journal.batches[key];
      if (Object.values(journal.batches).some(entry => entry.closedFingerprint === key &&
          ["completed", "abandoned"].includes(entry.remoteStatus))) { closed++; continue; }
      const active = open.filter(pr => {
        const scope = /^user\/calebzearing\/spelling-.+-([a-f0-9]{12})-[a-f0-9]{12}$/.exec(pr.branch);
        return scope ? scope[1] === batch.key : pr.branch.startsWith(prefix);
      });
      if (state?.phase === "reserved") {
        const receipt = readJson(path.join(store.records, "native-creators", `${state.ownerId}.json`));
        if (receipt?.verified) {
          if (receipt.taskId !== state.ownerId || receipt.agent !== agent ||
              receipt.branch !== state.branch || receipt.originKind !== "spool_automation" ||
              !active.some(pr => String(pr.id) === receipt.prId && samePrUrl(pr.url, receipt.prUrl))) {
            throw new Error("Recovered PR receipt does not match the current remote scope; publication held");
          }
          state.phase = "published"; state.prId = receipt.prId; state.prUrl = receipt.prUrl;
          state.publishedAt = now().toISOString(); save(); existing++; continue;
        }
      }
      if (active.length && !(state?.phase === "reserved" && active[0].branch === state.branch)) {
        if (active.length > 1) throw new Error(`Multiple open spelling PRs for ${batch.area}; publication held`);
        const owned = Object.entries(journal.batches).filter(([, entry]) =>
          entry.phase === "published" && String(entry.prId) === String(active[0].id));
        if (!owned.length) { existing++; continue; }
        if (owned.length !== 1) throw new Error("Existing spelling PR has ambiguous publication ownership");
        const [fingerprint, published] = owned[0];
        const result = await updateSpellingPr({ store, config, state: published, fingerprint, batch, report,
          save, get, call, publishCall, metadata, support, now });
        existing += result.existing || 0; updated += result.updated || 0; closed += result.closed || 0;
        continue;
      }
      if (state?.phase === "published") {
        const previous = await get(config.ado, state.prId, { refresh: true });
        if (!previous || previous.branch !== state.branch || !["completed", "abandoned"].includes(previous.status)) {
          throw new Error("Published PR was not found in active or terminal remote state; publication held");
        }
        state.remoteStatus = previous.status; save(); closed++; continue;
      }
      state ??= { phase: "planned", scannerVersion, branch: `${prefix}${batch.key}-${report.commit.slice(0, 12)}`,
        ownerId: `sauto-${key.slice(0, 32)}`, commit: report.commit, area: batch.area,
        files: batch.files.map(file => file.file), startedAt: now().toISOString() };
      journal.batches[key] = state; save();
      const admission = await withAdmission(store.root, agent, async () => {
        store.assertIdle(agent, root);
        support(store);
        if (state.phase === "planned") {
          const prepared = await call("bohemia_prepare", { repoRoot: root, operation: "branch",
            mode: "checkout", sourceCommit: report.commit, branch: state.branch, baseBranch: "master", reset: false,
            runSetup: true, runBuild: false });
          if (!prepared.ready || !samePath(prepared.repoRoot, root) || prepared.branch !== state.branch ||
              git(root, "rev-parse", "HEAD") !== report.commit) {
            throw new Error("Publication master differs from the scanned revision; rescan rather than guessing offsets");
          }
          state.phase = "prepared"; save();
        }
        if (git(root, "branch", "--show-current") !== state.branch) {
          const branch = git(root, "branch", "--show-current"), head = git(root, "rev-parse", "HEAD");
          const previous = Object.values(journal.batches).find(entry => entry.branch === branch && entry.phase === "published");
          const receipt = previous && readJson(path.join(store.records, "native-creators", `${previous.ownerId}.json`));
          const expectedHead = state.head || report.commit;
          if (git(root, "status", "--porcelain") || !previous || !receipt?.verified ||
              receipt.taskId !== previous.ownerId || receipt.agent !== agent || receipt.branch !== branch ||
              receipt.originKind !== "spool_automation" ||
              !open.some(pr => String(pr.id) === receipt.prId && pr.branch === branch && samePrUrl(pr.url, receipt.prUrl)) ||
              git(root, "ls-remote", "--heads", "origin", `refs/heads/${branch}`).split(/\s/)[0] !== head ||
              git(root, "rev-parse", `refs/heads/${state.branch}`) !== expectedHead) {
            throw new Error("Publication branch changed with unverified work; both branches preserved");
          }
          const recovered = await call("bohemia_prepare", { repoRoot: root, operation: "branch",
            mode: "checkout", branch: state.branch, expectedHead, reset: false, runSetup: false, runBuild: false });
          if (!recovered.ready || !samePath(recovered.repoRoot, root) || recovered.branch !== state.branch ||
              recovered.commit !== expectedHead || git(root, "branch", "--show-current") !== state.branch ||
              git(root, "rev-parse", "HEAD") !== expectedHead || git(root, "status", "--porcelain")) {
            throw new Error("Publication branch recovery was not verified; work preserved");
          }
        }
        if (state.phase === "prepared") {
          const expected = new Set(batch.files.map(file => file.file));
          const changed = git(root, "diff", "--name-only", "HEAD").split("\n").filter(Boolean);
          if (changed.some(file => !expected.has(file)) || git(root, "ls-files", "--others", "--exclude-standard")) {
            throw new Error("Publication checkout contains unrelated work");
          }
          const head = git(root, "rev-parse", "HEAD");
          if (head !== report.commit) {
            const committed = git(root, "diff", "--name-only", report.commit, "HEAD").split("\n").filter(Boolean);
            if (committed.some(file => !expected.has(file)) || changed.length ||
                batch.files.some(file => readFileSync(fullPath(root, file.file), "utf8").replace(/\r\n/g, "\n") !==
                  file.after.replace(/\r\n/g, "\n"))) {
              throw new Error("Unrecognized commit appeared during spelling publication; work preserved");
            }
            state.phase = "committed"; state.head = head; save();
          }
        }
        if (state.phase === "prepared") {
          for (const file of batch.files) {
            const current = readFileSync(fullPath(root, file.file), "utf8");
            if (current.replace(/\r\n/g, "\n") !== file.before.replace(/\r\n/g, "\n") &&
                current.replace(/\r\n/g, "\n") !== file.after.replace(/\r\n/g, "\n")) {
              throw new Error(`Source differs from the persisted correction plan: ${file.file}`);
            }
          }
          for (const file of batch.files) {
            const current = readFileSync(fullPath(root, file.file), "utf8");
            assertProseOnly(file.file, file.before, file.after);
            const next = current.includes("\r\n") ? file.after.replace(/\r?\n/g, "\r\n") : file.after;
            writeFileSync(fullPath(root, file.file), next, "utf8");
          }
          git(root, "diff", "--check");
          git(root, "add", "--", ...state.files);
          git(root, "commit", "-m", `docs: ${batch.area} spelling and grammar fixes`);
          state.phase = "committed"; state.head = git(root, "rev-parse", "HEAD"); save();
        }
        if (["committed", "metadata"].includes(state.phase)) {
          assertSubstantiveChanges(root, git(root, "rev-parse", "origin/master"), git(root, "rev-parse", "HEAD"));
          if (git(root, "status", "--porcelain")) {
            throw new Error("Publication checkout contains uncommitted work; metadata recovery held");
          }
          const head = git(root, "rev-parse", "HEAD");
          if (state.phase === "metadata" && head !== state.head) {
            throw new Error("Persisted metadata commit changed; publication held");
          }
          if (state.phase === "committed" && head !== state.head) {
            git(root, "merge-base", "--is-ancestor", state.head, head);
            const recovered = git(root, "diff", "--name-only", state.head, head).split("\n").filter(Boolean);
            if (!recovered.length || recovered.some(file => !file.startsWith("change/"))) {
              throw new Error("Unrecognized commit appeared during metadata recovery; work preserved");
            }
          } else if (state.phase === "committed") {
            await metadata();
          }
          const changes = git(root, "diff", "--name-only", report.commit, "HEAD").split("\n").filter(Boolean);
          if (changes.some(file => !state.files.includes(file) && !file.startsWith("change/"))) {
            throw new Error("Unexpected files changed during metadata generation; publication held");
          }
          for (const file of batch.files) {
            const current = readFileSync(fullPath(root, file.file), "utf8");
            assertProseOnly(file.file, file.before, current);
            if (current.replace(/\r\n/g, "\n") !== file.after.replace(/\r\n/g, "\n")) {
              throw new Error(`Commit hooks or metadata generation changed the planned correction: ${file.file}`);
            }
          }
          for (const file of changes.filter(file => file.startsWith("change/"))) {
            const change = JSON.parse(readFileSync(fullPath(root, file), "utf8"));
            if (change.type !== "none" || change.dependentChangeType !== "none") {
              throw new Error("Comment corrections must not introduce a release bump");
            }
            const extra = routing(file, rules);
            for (const role of roles) for (const alias of extra[role]) {
              if (!batch.files.some(source => source.reviewers[role].includes(alias))) {
                throw new Error(`Generated change metadata introduces an additional ${role} reviewer: ${alias}`);
              }
            }
          }
          state.head = git(root, "rev-parse", "HEAD");
          state.phase = "metadata"; save();
          const checked = await call("bohemia_check", { repoRoot: root, baseBranch: "master" });
          if (!checked.ready || checked.commit !== state.head || git(root, "status", "--porcelain")) {
            throw new Error("Required checks did not verify the exact clean spelling commit");
          }
          state.phase = "checked"; save();
        }
        if (state.phase === "checked") {
          const owner = await reserve({ id: state.ownerId, title: `${batch.area} spelling and grammar fixes`,
            branch: state.branch, commit: state.head });
          if (owner.taskId !== state.ownerId || !owner.deferred || !path.isAbsolute(owner.contextFile || "")) {
            throw new Error("Native Spool did not reserve the exact dormant owner");
          }
          state.contextFile = owner.contextFile; state.phase = "reserved"; save();
        }
        if (state.phase === "reserved") {
          if (git(root, "rev-parse", "HEAD") !== state.head || git(root, "status", "--porcelain")) {
            throw new Error("Verified publication commit changed; PR creation held");
          }
          const currentRules = reviewerRules(git(root, "show", `origin/master:${policyPath}`));
          for (const file of batch.files) {
            assert.deepEqual(routing(file.file, currentRules), file.reviewers,
              "Reviewer policy changed since scanning; publication held");
          }
          for (const file of git(root, "diff", "--name-only", report.commit, "HEAD").split("\n")
            .filter(file => file.startsWith("change/"))) {
            assert.deepEqual(routing(file, currentRules), routing(file, rules),
              "Reviewer policy changed for generated metadata; publication held");
          }
          const text = `${batch.area} spelling and grammar fixes`;
          await publishCall("bohemia_pr", { action: "create", repository: config.ado.repository,
            sourceBranch: state.branch, targetBranch: "master", draft: false, category: "docs", title: text,
            problem: `Spelling and grammar errors make ${batch.area} comments and documentation harder to read.`,
            solution: `Correct ${batch.corrections} prose errors across ${batch.files.length} files without changing executable code or interfaces.`,
            validation: "Required local checks passed and parser-based comparison confirmed nonprose content is unchanged.",
            uiChange: false }, { env: { BOHEMIA_CREATOR_CONTEXT: state.contextFile,
              COPILOT_SESSION_ID: "", SPOOL_PROVIDER_TOKEN: "" } });
          const receipt = readJson(path.join(store.records, "native-creators", `${state.ownerId}.json`));
          if (!receipt?.verified || receipt.agent !== agent || receipt.taskId !== state.ownerId ||
              receipt.branch !== state.branch || receipt.originKind !== "spool_automation") {
            throw new Error("Published PR is missing verified native deferred ownership");
          }
          state.phase = "published"; state.prId = receipt.prId; state.prUrl = receipt.prUrl;
          state.publishedAt = now().toISOString(); save(); created++;
          open.push({ id: receipt.prId, branch: state.branch });
        }
      }, root);
      if (admission?.holding) throw new Error(`Spelling publication held: ${admission.holding}`);
    }
    return { publicationVersion, created, existing, updated, closed, held: plan.held.length, batches: plan.batches.length };
  };
}
