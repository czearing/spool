import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { samePath, readJson } from "../../bridge/spool-store.mjs";
import { readCreatorResult, creatorResultHistory } from "../../bridge/creator-result.mjs";
import { assertProseOnly } from "./plan.mjs";
import { checkedPublicationState } from "./publication-continuity.mjs";
import { publicationForTask } from "../../bridge/publications.mjs";

const git = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8",
  windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const content = (repo, revision, file) => execFileSync("git", ["show", `${revision}:${file}`], {
  cwd: repo, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"] });

export function repairContext({ repo, state, owner, store }) {
  if (!store) return null;
  const binding = publicationForTask(store, owner, state);
  const task = store.task(owner), metadata = store.metadata(owner);
  const contract = metadata?.contract, prepared = metadata?.preparation;
  assert(binding?.verified && binding.taskId === owner && binding.prId === String(state.prId) &&
    binding.branch === state.branch && task?.agent === binding.agent &&
    task.session_id === binding.sessionId && samePath(binding.workspace, repo) &&
    contract?.identifier === owner && contract.agent === task.agent && contract.prId === binding.prId &&
    contract.branch === state.branch && samePath(contract.cwd, repo) && metadata.phase === "published" &&
    metadata.key === contract.submissionId, "Spelling repair requires its verified original Spool contract");
  const head = git(repo, "rev-parse", "HEAD");
  assert.equal(git(repo, "branch", "--show-current"), state.branch, "Spelling repair branch changed");
  assert.equal(git(repo, "ls-remote", "--heads", "origin", `refs/heads/${state.branch}`).split(/\s/)[0],
    head, "Spelling repair requires the exact remotely published head");
  assert.equal(contract.head, head, "Spelling handoff is stale");
  assert(prepared?.ready && prepared.commit === head && prepared.branch === state.branch &&
    samePath(prepared.repoRoot, repo), "Spelling preparation does not match its original handoff");
  if (state.head !== head) {
    const checked = checkedPublicationState({ repo, state, owner, binding, head });
    if (checked) state = checked;
    const publications = binding.publications || [];
    let proven = publications.some(record => record.head === head && record.taskId === owner &&
      record.prId === binding.prId && record.branch === state.branch && record.checked === true);
    for (const key of creatorResultHistory(store)(task)) {
      const result = readCreatorResult(store, task, key);
      const receipt = typeof result?.submissionId === "string" && store.receipt(result.submissionId);
      if (result?.head === head && receipt?.phase === "published" && receipt.taskId === owner &&
          receipt.prId === binding.prId && receipt.contract?.agent === binding.agent &&
          receipt.contract?.branch === state.branch && receipt.contract?.head === state.head) proven = true;
    }
    assert(proven, "Newer spelling head has no verified original-agent publication evidence");
    git(repo, "merge-base", "--is-ancestor", state.head, head);
    for (const file of git(repo, "diff", "--name-only", state.head, head).split("\n").filter(Boolean)) {
      assert(state.files.includes(file) || file.startsWith("change/"), "Newer spelling publication contains unrelated work");
      if (state.files.includes(file)) assertProseOnly(file, content(repo, state.head, file), content(repo, head, file));
      else {
        const change = JSON.parse(content(repo, head, file));
        assert(change.type === "none" && change.dependentChangeType === "none", "Spelling publication changes release metadata");
      }
    }
  }
  const mergeFile = path.resolve(repo, git(repo, "rev-parse", "--git-path", "MERGE_HEAD"));
  if (!existsSync(mergeFile)) return { head, state: { ...state, head }, merge: null };
  const target = readFileSync(mergeFile, "utf8").trim();
  assert(/^[a-f0-9]{40}$/.test(target) && prepared.merge?.conflicted &&
    prepared.merge.targetCommit === target && git(repo, "rev-parse", "ORIG_HEAD") === head,
  "Spelling repair merge does not match canonical preparation");
  const tree = git(repo, "rev-parse", "AUTO_MERGE"), base = git(repo, "merge-base", head, target);
  for (const operation of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_AUTOSTASH", "rebase-apply", "rebase-merge"]) {
    assert(!existsSync(path.resolve(repo, git(repo, "rev-parse", "--git-path", operation))),
      "Competing Git operation blocks spelling repair");
  }
  const stages = git(repo, "ls-files", "--unmerged", "-z");
  const entries = stages.split("\0").filter(Boolean);
  const deleted = [...new Set(entries.map(entry => entry.slice(entry.indexOf("\t") + 1)))];
  assert.deepEqual([...deleted].sort(), [...prepared.merge.files].sort(), "Prepared conflict paths changed");
  for (const file of deleted) {
    assert(state.files.includes(file), "Spelling conflict is outside its published batch");
    const rows = entries.filter(entry => entry.slice(entry.indexOf("\t") + 1) === file);
    assert.equal(rows.length, 2, "Only verified target deletions can be resolved automatically");
    assert.equal(git(repo, "--literal-pathspecs", "ls-tree", target, "--", file), "",
      "The target did not delete the conflicted file");
    for (const row of rows) {
      const [mode, object, stage] = row.slice(0, row.indexOf("\t")).split(" ");
      assert(["1", "2"].includes(stage), "Unexpected deletion conflict stage");
      assert.equal(git(repo, "--literal-pathspecs", "ls-tree", stage === "1" ? base : head, "--", file).split("\t")[0],
        `${mode} blob ${object}`, "Conflict index contains authored changes");
    }
    assertProseOnly(file, content(repo, base, file), content(repo, head, file));
  }
  const unchanged = () => {
    assert.equal(git(repo, "rev-parse", "HEAD"), head, "Prepared spelling head changed");
    assert.equal(git(repo, "rev-parse", "MERGE_HEAD"), target, "Prepared spelling target changed");
    assert.equal(git(repo, "rev-parse", "AUTO_MERGE"), tree, "Prepared merge snapshot changed");
    assert.equal(git(repo, "ls-files", "--unmerged", "-z"), stages, "Prepared merge index changed");
    assert.equal(git(repo, "diff", "--no-ext-diff", "--no-textconv", "AUTO_MERGE", "--name-only"), "",
      "Prepared merge contains authored changes");
    assert.equal(git(repo, "diff", "--cached", "--no-ext-diff", "--no-textconv", "AUTO_MERGE",
      "--name-only", "--diff-filter=ACDMRT"), "", "Prepared merge index contains authored changes");
    assert.equal(git(repo, "ls-files", "--others", "--exclude-standard"), "", "Untracked work blocks spelling repair");
    for (const file of git(repo, "diff", "--cached", "--name-only", target).split("\n").filter(Boolean)) {
      assert(state.files.includes(file) || file.startsWith("change/"),
        "Prepared target-relative diff contains unrelated work");
    }
  };
  unchanged();
  return { head, state: { ...state, head, commit: target, files: state.files.filter(file => !deleted.includes(file)) },
    merge: { target, deleted, unchanged } };
}
