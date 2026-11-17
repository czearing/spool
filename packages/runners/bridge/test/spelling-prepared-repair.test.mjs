import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { publication, before } from "./spelling-publication-fixture.mjs";
import { digest, readJson, writeJson } from "../spool-store.mjs";
import { repairContext } from "../../scanners/spelling/repair-context.mjs";
import { regenerateBatch } from "../../scanners/spelling/repair.mjs";
import { reconcileSpellingPublication } from "../../scanners/spelling/publication-continuity.mjs";
import { recordCheckedPublication } from "../../packages/bohemia-pr-mcp/src/pr-origin.mjs";

function prepared(t) {
  const f = publication(t), repo = f.publicationRoot, git = (...args) => f.git(repo, ...args);
  const file = "packages/a/src/a.ts", survivor = "packages/a/src/survivor.ts";
  const survivorBefore = before.replace("\nexport", "\n\n\n\n\n\nexport");
  f.git(f.workspace, "checkout", "-b", "target");
  writeFileSync(path.join(f.workspace, survivor), survivorBefore);
  f.git(f.workspace, "add", "."); f.git(f.workspace, "commit", "-m", "Baseline survivor");
  git("fetch", "origin", "target");
  const baseline = git("rev-parse", "origin/target"), branch = "user/spelling", owner = "spelling-owner";
  git("checkout", "-b", branch, baseline);
  for (const name of [file, survivor]) writeFileSync(path.join(repo, name),
    (name === survivor ? survivorBefore : before).replace("missspelled", "misspelled"));
  git("add", "."); git("commit", "-m", "Published spelling");
  const published = git("rev-parse", "HEAD");
  for (const name of [file, survivor]) writeFileSync(path.join(repo, name),
    (name === survivor ? survivorBefore : before).replace("missspelled", "corrected"));
  git("add", "."); git("commit", "-m", "Withdraw unsafe correction");
  const head = git("rev-parse", "HEAD");
  git("push", "origin", branch);
  f.git(f.workspace, "rm", file);
  writeFileSync(path.join(f.workspace, survivor), survivorBefore.replace("value = 1", "value = 2"));
  writeFileSync(path.join(f.workspace, "target-only.ts"), "export const target = 3;\n");
  f.git(f.workspace, "add", "."); f.git(f.workspace, "commit", "-m", "Target removes obsolete file and changes code");
  git("fetch", "origin", "target");
  const target = git("rev-parse", "origin/target");
  assert.throws(() => git("merge", "--no-edit", "origin/target"));
  const state = { phase: "published", ownerId: owner, prId: "123", branch, head: published,
    commit: baseline, files: [file, survivor] };
  const historical = "previous-publication", current = "current-handoff";
  const context = { taskId: owner, agent: "spelling", sessionId: "00000000-0000-4000-8000-000000000001", workspace: repo,
    branch, projectRoot: f.root, receiptDirectory: f.store.publicationDirectory };
  writeJson(path.join(f.store.records, "native-creators", `${owner}.json`), { ...context, verified: true,
    prId: state.prId, prUrl: "https://example.invalid/OC/_git/fixture/pullrequest/123" });
  const contract = { identifier: owner, agent: "spelling", prId: state.prId, branch, head, cwd: repo, submissionId: current };
  const metadata = { phase: "published", key: current, contract,
    preparation: { ready: true, commit: head, repoRoot: repo, branch,
      merge: { conflicted: true, targetCommit: target, files: [file] } } };
  f.put({ id: owner, agent: "spelling", session_id: context.sessionId, workspace: repo, runner_metadata: metadata }, "failed");
  writeJson(path.join(f.store.records, `${digest(historical)}.json`), { key: historical, phase: "published", taskId: owner,
    prId: state.prId, contract: { ...contract, head: published } });
  writeJson(path.join(f.store.records, "results", `${digest(historical)}.json`), { submissionId: historical, head });
  const journal = { version: 1, batches: { batch: state } };
  return { ...f, repo, git, owner, state, file, survivor, head, target, context, metadata, journal,
    options: { repo, state, owner, store: f.store },
    regeneration: { repo, journal, owner, store: f.store } };
}

test("canonical merge repair accepts proven newer owner work and preserves target deletions and executable changes", async t => {
  const f = prepared(t), snapshot = f.git("status", "--porcelain"), index = f.git("ls-files", "--stage");
  const targetContent = readFileSync(path.join(f.repo, "target-only.ts"));
  const preview = await regenerateBatch(f.regeneration);
  assert.deepEqual(preview.deletedFiles, [f.file]);
  assert.equal(preview.mergeTarget, f.target);
  assert.equal(f.git("status", "--porcelain"), snapshot);
  assert.equal(f.git("ls-files", "--stage"), index);
  const applied = await regenerateBatch({ ...f.regeneration, apply: true });
  assert.equal(existsSync(path.join(f.repo, f.file)), false);
  assert.equal(f.git("ls-files", "--unmerged"), "");
  assert.match(readFileSync(path.join(f.repo, f.survivor), "utf8"), /value = 2/);
  assert.deepEqual(readFileSync(path.join(f.repo, "target-only.ts")), targetContent);
  assert.equal(applied.publishedHead, f.head);
});

for (const kind of ["unknown-head", "authored", "staged", "untracked", "wrong-target", "wrong-owner", "competing-operation"]) {
  test(`prepared repair holds ${kind} without changing merge or authored work`, t => {
    const f = prepared(t);
    if (kind === "unknown-head") writeJson(path.join(f.store.records, `${digest("previous-publication")}.json`), {});
    if (kind === "authored") writeFileSync(path.join(f.repo, "target-only.ts"), "export const target = 4;\n");
    if (kind === "staged") {
      writeFileSync(path.join(f.repo, "target-only.ts"), "export const target = 4;\n");
      f.git("add", "target-only.ts");
    }
    if (kind === "untracked") writeFileSync(path.join(f.repo, "notes.txt"), "preserve");
    if (kind === "wrong-target") f.metadata.preparation.merge.targetCommit = f.head;
    if (kind === "wrong-owner") f.metadata.contract.agent = "perf";
    if (kind === "competing-operation") writeFileSync(path.join(f.repo, ".git", "CHERRY_PICK_HEAD"), f.head + "\n");
    f.put({ ...f.store.task(f.owner), runner_metadata: f.metadata }, "failed");
    const status = f.git("status", "--porcelain"), stages = f.git("ls-files", "--stage");
    assert.throws(() => repairContext(f.options));
    assert.equal(f.git("status", "--porcelain"), status);
    assert.equal(f.git("ls-files", "--stage"), stages);
  });
}

test("checked original-owner publication reconciles the same journal after a merge and is restart-idempotent", async t => {
  const f = prepared(t);
  await regenerateBatch({ ...f.regeneration, apply: true });
  f.git("add", f.survivor); f.git("commit", "-m", "Merge target preserving deletions and prose");
  f.git("push", "origin", f.state.branch);
  const head = f.git("rev-parse", "HEAD");
  writeJson(path.resolve(f.repo, f.git("rev-parse", "--git-path", "bohemia-gate-pass.json")), {
    head, targetBranch: "origin/target", targetCommit: f.target, passedAt: new Date().toISOString(),
  });
  const pr = { pullRequestId: 123, sourceRefName: `refs/heads/${f.state.branch}`, targetRefName: "refs/heads/target",
    lastMergeSourceCommit: { commitId: head }, status: "active" };
  const journalFile = path.join(f.root, ".runner", "automation", "runners", "spelling", ".runner", "spelling-publications.json");
  writeJson(journalFile, f.journal);
  await recordCheckedPublication({ context: f.context, repoRoot: f.repo, pr,
    prUrl: "https://example.invalid/OC/_git/fixture/pullrequest/123", headCommit: head, targetCommit: f.target });
  assert.equal(reconcileSpellingPublication({ store: f.store, owner: f.owner,
    pr: { id: "123", branch: f.state.branch, sourceCommit: head } }), true);
  const state = readJson(journalFile).batches.batch;
  assert.equal(state.head, head);
  assert.equal(state.commit, f.target);
  assert.deepEqual(state.files, [f.survivor]);
  assert.equal(reconcileSpellingPublication({ store: f.store, owner: f.owner,
    pr: { id: "123", branch: f.state.branch, sourceCommit: head } }), false);
  await assert.rejects(recordCheckedPublication({ context: { ...f.context, sessionId: "unrelated" },
    repoRoot: f.repo, pr, prUrl: "https://example.invalid/OC/_git/fixture/pullrequest/123",
    headCommit: head, targetCommit: f.target }), /publishing conversation/);
});
