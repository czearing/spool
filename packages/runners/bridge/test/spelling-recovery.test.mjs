import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./fixtures.mjs";
import { preserveGeneratedRepair } from "../../scanners/spelling/recover.mjs";

function setup(t) {
  const { workspace: repo } = fixture(t);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=fixture");
  git("config", "user.name", "Spool Test");
  git("config", "user.email", "spool@example.invalid");
  git("config", "core.autocrlf", "false");
  mkdirSync(path.join(repo, "packages", "a"), { recursive: true });
  const file = "packages/a/example.ts", target = path.join(repo, "packages", "a", "example.ts");
  const before = "// Compare AN against B.\nexport const value = 1;\n";
  const after = "// Compare A against B.\nexport const value = 1;\n";
  writeFileSync(target, before);
  git("add", "."); git("commit", "-m", "Published fixture");
  const head = git("rev-parse", "HEAD"), owner = "fixture-owner";
  const journal = { version: 1, batches: { fixture: { phase: "published", ownerId: owner,
    branch: "fixture", commit: head, head, files: [file] } } };
  const report = { version: 1, scannerVersion: 9, applied: true, owner, branch: "fixture",
    sourceCommit: head, publishedHead: head, files: [{ file, before, after }] };
  writeFileSync(target, after);
  return { repo, git, target, before, after, options: { repo, journal, owner, report } };
}

test("recovery preserves the complete generated patch in a stash and leaves the published head clean", t => {
  const f = setup(t);
  const result = preserveGeneratedRepair(f.options);
  assert.equal(result.files, 1);
  assert.match(result.stash, /^[a-f0-9]{40}$/);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(readFileSync(f.target, "utf8"), f.before);
  assert.equal(f.git("show", `${result.stash}:packages/a/example.ts`), f.after.trim());
  assert.match(f.git("stash", "list"), /Spool spelling recovery fixture-owner/);
});

for (const change of ["authored", "staged", "untracked", "owner", "head", "baseline", "duplicate", "path"]) {
  test(`recovery refuses ${change} changes without altering the worktree`, t => {
    const f = setup(t);
    if (change === "authored") writeFileSync(f.target, f.after + "// Another edit.\n");
    if (change === "staged") f.git("add", ".");
    if (change === "untracked") writeFileSync(path.join(f.repo, "notes.txt"), "preserve");
    if (change === "owner") f.options.report.owner = "different";
    if (change === "head") f.git("commit", "--allow-empty", "-m", "Newer work");
    if (change === "baseline") f.options.report.files[0].before = "different";
    if (change === "duplicate") f.options.report.files.push(f.options.report.files[0]);
    if (change === "path") f.options.report.files[0].file = "packages/a/../../outside.ts";
    const before = readFileSync(f.target, "utf8"), status = f.git("status", "--porcelain");
    assert.throws(() => preserveGeneratedRepair(f.options));
    assert.equal(readFileSync(f.target, "utf8"), before);
    assert.equal(f.git("status", "--porcelain"), status);
    assert.equal(f.git("stash", "list"), "");
  });
}
