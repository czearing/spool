import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readJson, samePath, writeJson } from "../../bridge/spool-store.mjs";
import { assertProseOnly } from "./plan.mjs";
import { publicationForTask } from "../../bridge/publications.mjs";

const git = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true,
  maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const content = (repo, revision, file) => execFileSync("git", ["show", `${revision}:${file}`], {
  cwd: repo, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"] });

export function checkedPublicationState({ repo, state, owner, binding, head }) {
  const record = binding.publications?.find(publication => publication.head === head && publication.checked === true &&
    publication.taskId === owner && publication.prId === String(state.prId) && publication.branch === state.branch);
  if (!record) return null;
  assert(/^[a-f0-9]{40}$/.test(record.baseCommit || ""), "Checked publication baseline is missing");
  git(repo, "merge-base", "--is-ancestor", state.head, head);
  git(repo, "merge-base", "--is-ancestor", record.baseCommit, head);
  const allowed = new Set(state.files);
  if (state.commit !== record.baseCommit) {
    assert(/^[a-f0-9]{40}$/.test(state.commit || ""), "Spelling journal baseline is missing");
    git(repo, "merge-base", "--is-ancestor", state.commit, record.baseCommit);
    const renames = git(repo, "diff", "--name-status", "--find-renames", "--diff-filter=R", "-z",
      state.commit, record.baseCommit).split("\0").filter(Boolean);
    for (let index = 0; index < renames.length; index += 3) {
      const [status, previous, current] = renames.slice(index, index + 3);
      assert(/^R\d+$/.test(status) && previous && current, "Invalid target rename evidence");
      if (state.files.includes(previous)) allowed.add(current);
    }
  }
  const files = [];
  for (const file of git(repo, "diff", "--name-only", record.baseCommit, head).split("\n").filter(Boolean)) {
    if (allowed.has(file)) {
      assertProseOnly(file, content(repo, record.baseCommit, file), content(repo, head, file));
      files.push(file);
    } else {
      assert(file.startsWith("change/"), "Checked spelling publication contains unrelated work");
      const change = JSON.parse(content(repo, head, file));
      assert(change.type === "none" && change.dependentChangeType === "none", "Spelling publication contains a release bump");
    }
  }
  assert(files.length, "Checked spelling publication contains no prose corrections");
  return { ...state, head, commit: record.baseCommit, files, checkedPublicationAt: record.publishedAt };
}

export function reconcileSpellingPublication({ store, owner, pr }) {
  const journalFile = path.join(store.root, ".runner", "automation", "runners", "spelling", ".runner", "spelling-publications.json");
  const journal = readJson(journalFile);
  if (!journal) return false;
  const matches = Object.entries(journal.batches || {}).filter(([, state]) => state.ownerId === owner);
  if (!matches.length) return false;
  assert(journal.version === 1 && matches.length === 1, "Ambiguous spelling publication journal");
  const [key, state] = matches[0], binding = publicationForTask(store, owner, { prId: pr.id, prUrl: pr.url, branch: pr.branch });
  assert(binding?.verified && binding.taskId === owner && binding.prId === String(pr.id) &&
    binding.branch === pr.branch && state.branch === pr.branch && String(state.prId) === String(pr.id),
  "Spelling journal publication identity does not match the original owner");
  if (state.head === pr.sourceCommit) return false;
  assert(samePath(binding.workspace, store.task(owner)?.workspace), "Spelling publication checkout changed");
  const next = checkedPublicationState({ repo: binding.workspace, state, owner, binding, head: pr.sourceCommit });
  if (!next) return false;
  const latest = readJson(journalFile);
  assert.deepEqual(latest, journal, "Spelling journal changed during publication reconciliation");
  writeJson(journalFile, { ...journal, batches: { ...journal.batches, [key]: next } });
  return true;
}
