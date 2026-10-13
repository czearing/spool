import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readJson } from "../spool-store.mjs";
import { publication, before, finding, policy, rule } from "./spelling-publication-fixture.mjs";
import { assertActiveUpdate } from "../../packages/bohemia-pr-mcp/src/pr-update-guard.mjs";

test("canonical publication refuses closed or retargeted PRs after long-running checks", () => {
  const pr = { pullRequestId: 123, status: "active", sourceRefName: "refs/heads/spelling",
    targetRefName: "refs/heads/master" };
  assert.doesNotThrow(() => assertActiveUpdate(pr));
  for (const status of ["completed", "abandoned", undefined]) {
    assert.throws(() => assertActiveUpdate({ ...pr, status }, pr), /no longer active/);
  }
  assert.throws(() => assertActiveUpdate({ ...pr, sourceRefName: "refs/heads/other" }, pr), /branches changed/);
  assert.throws(() => assertActiveUpdate({ ...pr, targetRefName: "refs/heads/other" }, pr), /branches changed/);
});

const state = f => Object.values(readJson(path.join(f.runtime, "spelling-publications.json")).batches)[0];
function advance(f) {
  writeFileSync(path.join(f.workspace, "packages", "a", "src", "b.ts"), before);
  f.git(f.workspace, "add", "."); f.git(f.workspace, "commit", "-m", "more documentation");
  f.report.commit = f.git(f.workspace, "rev-parse", "HEAD");
  f.report.findings.push(finding("packages/a/src/b.ts"));
}

test("fresh scans extend the existing PR and original owner instead of creating another PR", async t => {
  const f = publication(t);
  await f.publisher()(f.report);
  const initial = state(f);
  advance(f);
  const result = await f.publisher()(f.report), updated = state(f);
  assert.equal(result.updated, 1); assert.equal(result.created, 0);
  assert.equal(f.posts(), 1); assert.equal(f.updates(), 1);
  assert.equal(updated.ownerId, initial.ownerId); assert.equal(updated.prId, initial.prId);
  assert.equal(updated.branch, initial.branch); assert.equal(updated.commit, f.report.commit);
  assert.equal(updated.head, f.prs[0].sourceCommit);
  assert.notEqual(updated.head, initial.head);
  assert.equal(f.git(f.publicationRoot, "merge-base", "--is-ancestor", initial.head, updated.head), "");
  assert.equal(f.store.tasks().length, 1);
  assert.equal(f.store.tasks()[0].turns, 0);
  for (const name of ["a.ts", "b.ts"]) assert.equal(
    readFileSync(path.join(f.publicationRoot, "packages", "a", "src", name), "utf8").replace(/\r\n/g, "\n"),
    before.replace("missspelled", "misspelled"));
  assert.equal((await f.publisher()(f.report)).existing, 1);
  assert.equal(f.updates(), 1);
});

test("unrelated master changes do not rebuild or push identical spelling corrections", async t => {
  const f = publication(t);
  await f.publisher()(f.report);
  const calls = f.calls.length, baseline = state(f).commit;
  writeFileSync(path.join(f.workspace, "README.md"), "Unrelated documentation.\n");
  f.git(f.workspace, "add", "."); f.git(f.workspace, "commit", "-m", "unrelated master change");
  f.report.commit = f.git(f.workspace, "rev-parse", "HEAD");
  assert.equal((await f.publisher()(f.report)).existing, 1);
  assert.equal(f.calls.length, calls); assert.equal(f.updates(), 0);
  assert.equal(state(f).commit, baseline);
});

test("reviewer identity reuses a PR even when its display area changes as packages are added", async t => {
  const f = publication(t);
  writeFileSync(path.join(f.workspace, ".azuredevops", "policies", "branchpolicies", "master", "requiredReviewers.yml"),
    policy([rule("/packages/**", ["other"])]));
  f.git(f.workspace, "add", "."); f.git(f.workspace, "commit", "-m", "reviewer scope");
  f.report.commit = f.git(f.workspace, "rev-parse", "HEAD");
  await f.publisher()(f.report);
  const branch = state(f).branch;
  assert.match(branch, /spelling-a-/);
  mkdirSync(path.join(f.workspace, "packages", "b", "src"), { recursive: true });
  writeFileSync(path.join(f.workspace, "packages", "b", "src", "b.ts"), before);
  f.git(f.workspace, "add", "."); f.git(f.workspace, "commit", "-m", "same reviewers in another package");
  f.report.commit = f.git(f.workspace, "rev-parse", "HEAD");
  f.report.findings.push(finding("packages/b/src/b.ts"));
  assert.equal((await f.publisher()(f.report)).updated, 1);
  assert.equal(state(f).branch, branch);
  assert.equal(f.posts(), 1); assert.equal(f.updates(), 1);
});

test("closure after listing prevents preparation and does not reopen the PR", async t => {
  const f = publication(t);
  await f.publisher()(f.report); advance(f);
  const calls = f.calls.length, head = state(f).head;
  const get = async (...args) => { f.prs[0].status = "abandoned"; return f.options.get(...args); };
  assert.equal((await f.publisher({ get })(f.report)).closed, 1);
  assert.equal(f.calls.length, calls); assert.equal(f.updates(), 0); assert.equal(f.posts(), 1);
  assert.equal(f.git(f.publicationRoot, "rev-parse", "HEAD"), head);
  assert.equal((await f.publisher()(f.report)).closed, 1);
  assert.equal(f.posts(), 1);
});

test("closure during validation preserves prepared work without publishing or creating a replacement", async t => {
  const f = publication(t);
  await f.publisher()(f.report); advance(f);
  const call = async (name, args) => {
    const result = await f.options.call(name, args);
    if (name === "bohemia_check") f.prs[0].status = "abandoned";
    return result;
  };
  assert.equal((await f.publisher({ call })(f.report)).closed, 1);
  const pending = state(f).refresh.head;
  assert.equal(f.git(f.publicationRoot, "rev-parse", "HEAD"), pending);
  assert.equal(f.updates(), 0); assert.equal(f.posts(), 1);
  assert.equal((await f.publisher()(f.report)).closed, 1);
  assert.equal(f.posts(), 1);
});

test("an unknown remote revision is held rather than overwritten or duplicated", async t => {
  const f = publication(t);
  await f.publisher()(f.report); advance(f);
  f.prs[0].sourceCommit = "f".repeat(40);
  const head = f.git(f.publicationRoot, "rev-parse", "HEAD");
  await assert.rejects(f.publisher()(f.report), /unverified newer work/);
  assert.equal(f.git(f.publicationRoot, "rev-parse", "HEAD"), head);
  assert.equal(f.posts(), 1); assert.equal(f.updates(), 0);
});

test("uncommitted authored work remains byte-for-byte untouched", async t => {
  const f = publication(t);
  await f.publisher()(f.report); advance(f);
  const file = path.join(f.publicationRoot, "packages", "a", "src", "a.ts");
  const authored = "// Keep this authored comment.\nexport const value = 1;\n";
  writeFileSync(file, authored);
  await assert.rejects(f.publisher()(f.report), /Uncommitted work/);
  assert.equal(readFileSync(file, "utf8"), authored);
  assert.equal(f.posts(), 1); assert.equal(f.updates(), 0);
});

test("validation failures resume the same committed refresh without another PR or commit", async t => {
  const f = publication(t);
  await f.publisher()(f.report); advance(f);
  const call = async (name, args) => {
    if (name === "bohemia_check") throw new Error("checks unavailable");
    return f.options.call(name, args);
  };
  await assert.rejects(f.publisher({ call })(f.report), /checks unavailable/);
  const head = state(f).refresh.head;
  assert.equal((await f.publisher()(f.report)).updated, 1);
  assert.equal(state(f).head, head); assert.equal(state(f).refresh, undefined);
  assert.equal(f.posts(), 1); assert.equal(f.updates(), 1);
});

test("lost update responses reconcile the pushed revision without replacing the PR", async t => {
  const f = publication(t);
  await f.publisher()(f.report); advance(f);
  const publishCall = async (...args) => {
    await f.options.publishCall(...args);
    throw new Error("response lost");
  };
  await assert.rejects(f.publisher({ publishCall })(f.report), /response lost/);
  const head = f.prs[0].sourceCommit;
  assert.equal((await f.publisher()(f.report)).updated, 1);
  assert.equal(state(f).head, head);
  assert.equal(f.posts(), 1);
});
