import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const normalize = text => text.replace(/\r\n/g, "\n");

export function preserveGeneratedRepair({ repo, journal, owner, report }) {
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8",
    windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  assert(path.isAbsolute(repo), "Recovery requires an absolute assigned checkout");
  const matches = Object.values(journal.batches || {}).filter(state => state.ownerId === owner);
  assert(journal.version === 1 && matches.length === 1, "Recovery requires one exact publication owner");
  const state = matches[0];
  assert(state.phase === "published" && report.version === 1 && report.applied === true &&
    report.owner === owner && report.branch === state.branch && report.publishedHead === state.head &&
    report.sourceCommit === state.commit, "Recovery receipt does not match the published batch");
  assert.equal(git("branch", "--show-current").trim(), state.branch, "Recovery branch changed");
  assert.equal(git("rev-parse", "HEAD").trim(), state.head, "Recovery head changed");
  assert(Array.isArray(report.files) && report.files.length > 0, "Recovery receipt has no generated files");
  const files = report.files.map(file => file.file);
  assert.equal(new Set(files).size, files.length, "Duplicate recovery paths");
  for (const file of report.files) {
    assert(typeof file.file === "string" &&
      /^(?:packages|apps)\/[^/]+\/.+\.(?:md|[cm]?js|jsx|tsx?)$/i.test(file.file) &&
      !file.file.includes("\\") && !file.file.split("/").includes("..") &&
      state.files.includes(file.file), "Recovery path is outside the published batch");
    assert(typeof file.before === "string" && typeof file.after === "string", "Incomplete recovery content");
    const target = path.join(repo, ...file.file.split("/"));
    assert(lstatSync(target).isFile(), "Recovery refuses nonregular files");
    assert.equal(normalize(git("show", `${state.head}:${file.file}`)), normalize(file.before),
      `Recovery baseline changed: ${file.file}`);
    assert.equal(normalize(readFileSync(target, "utf8")), normalize(file.after),
      `Generated output has subsequent edits: ${file.file}`);
  }
  const changes = git("status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0").filter(Boolean);
  assert.deepEqual(changes.sort(), files.map(file => ` M ${file}`).sort(),
    "Recovery refuses staged, untracked, or unrelated changes");
  git("stash", "push", "--message", `Spool spelling recovery ${owner}`, "--", ...files);
  const stash = git("rev-parse", "refs/stash").trim();
  assert.equal(git("rev-parse", `${stash}^1`).trim(), state.head, "Recovery stash baseline mismatch");
  assert.equal(git("status", "--porcelain").trim(), "", "Recovery did not leave a clean checkout");
  for (const file of report.files) {
    assert.equal(normalize(git("show", `${stash}:${file.file}`)), normalize(file.after),
      `Generated output was not preserved: ${file.file}`);
  }
  return { stash, owner, head: state.head, files: files.length };
}
