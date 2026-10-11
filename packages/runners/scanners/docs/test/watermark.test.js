import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocsGate } from "../config.js";
import { gitHead, changedPaths } from "../watermark.js";
import { fixtureRepo, trees } from "./helpers.js";

function git(cwd, args) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "docs-watermark-"));
  const repo = join(dir, "repo");
  cpSync(fixtureRepo, repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Root\n\nOut of the measured trees.\n", "utf8");
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "engine@example.invalid"]);
  git(repo, ["config", "user.name", "docs engine test"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "first"]);
  return { dir, repo, state: join(dir, "watermark.json") };
}

function commitChange(repo, relPath, text) {
  const full = join(repo, relPath.split("/").join("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  appendFileSync(full, text, "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", `change ${relPath}`]);
}

test("an unchanged watermark refuses the cycle", async () => {
  const h = makeRepo();
  try {
    const gate = createDocsGate({ repoRoot: h.repo, trees, watermarkPath: h.state, force: false });
    const first = await gate.evaluate();
    assert.equal(first.proceed, true);
    assert.equal(first.reason, "first_run");
    gate.commit({ proceed: true, selection: { reason: "no_document_set_over_budget" } });

    const second = await gate.evaluate();
    assert.equal(second.proceed, false);
    assert.equal(second.reason, "mark_unchanged");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a watermark that moved with no in scope change refuses the cycle", async () => {
  const h = makeRepo();
  try {
    const gate = createDocsGate({ repoRoot: h.repo, trees, watermarkPath: h.state, force: false });
    await gate.evaluate();
    gate.commit({ proceed: true, selection: { reason: "no_document_set_over_budget" } });

    commitChange(h.repo, "README.md", "\nA line outside the measured trees.\n");
    const moved = await gate.evaluate();
    assert.equal(moved.proceed, false);
    assert.equal(moved.reason, "no_relevant_change");
    assert.equal(moved.detail.inScopeCount, 0);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a watermark that moved for an excluded file only refuses the cycle", async () => {
  const h = makeRepo();
  try {
    const gate = createDocsGate({ repoRoot: h.repo, trees, watermarkPath: h.state, force: false });
    await gate.evaluate();
    gate.commit({ proceed: true, selection: { reason: "no_document_set_over_budget" } });

    commitChange(h.repo, "apps/new-office/docs/AGENTS.md", "\nMore fixture text that is never measured.\n");
    const moved = await gate.evaluate();
    assert.equal(moved.proceed, false);
    assert.equal(moved.reason, "no_relevant_change");
    assert.equal(moved.detail.skipped.length, 1);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a watermark that moved with an in scope change proceeds", async () => {
  const h = makeRepo();
  try {
    const gate = createDocsGate({ repoRoot: h.repo, trees, watermarkPath: h.state, force: false });
    await gate.evaluate();
    gate.commit({ proceed: true, selection: { reason: "no_document_set_over_budget" } });

    commitChange(h.repo, "apps/new-office/docs/guide.md", "\nAnother sentence that says nothing at all.\n");
    const moved = await gate.evaluate();
    assert.equal(moved.proceed, true);
    assert.equal(moved.reason, "relevant_change");
    assert.deepEqual(moved.detail.inScope, ["apps/new-office/docs/guide.md"]);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a forced run proceeds on an unchanged watermark and leaves a real commit behind", async () => {
  const h = makeRepo();
  try {
    const gate = createDocsGate({ repoRoot: h.repo, trees, watermarkPath: h.state, force: false });
    await gate.evaluate();
    gate.commit({ proceed: true, selection: { reason: "no_document_set_over_budget" } });

    const forced = createDocsGate({ repoRoot: h.repo, trees, watermarkPath: h.state, force: true });
    const run = await forced.evaluate();
    assert.equal(run.proceed, true);
    assert.equal(run.reason, "bypassed");
    forced.commit({ proceed: true, selection: { reason: "no_document_set_over_budget" } });

    const head = gitHead(h.repo);
    const after = createDocsGate({ repoRoot: h.repo, trees, watermarkPath: h.state, force: false });
    const next = await after.evaluate();
    assert.equal(next.previous, head, "the forced run recorded the commit it actually observed");
    assert.equal(next.reason, "mark_unchanged");

    commitChange(h.repo, "apps/new-office/docs/guide.md", "\nA line in scope.\n");
    const moved = await after.evaluate();
    assert.equal(moved.proceed, true);
    assert.notEqual(moved.detail.reason, "diff unavailable, measuring everything");
    assert.ok(moved.detail.inScopeCount > 0, "the diff after a forced run is a real diff");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the watermark reads a real head and a real diff from the measured clone", () => {
  const h = makeRepo();
  try {
    const first = gitHead(h.repo);
    assert.match(first, /^[0-9a-f]{40}$/);
    commitChange(h.repo, "apps/new-office/docs/guide.md", "\nOne more line.\n");
    const second = gitHead(h.repo);
    assert.notEqual(first, second);
    assert.deepEqual(changedPaths({ repoRoot: h.repo, from: first, to: second }), [
      "apps/new-office/docs/guide.md",
    ]);
    assert.equal(gitHead(join(h.dir, "not-a-repo")), null);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
