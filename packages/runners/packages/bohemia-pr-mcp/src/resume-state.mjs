import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREPARATION_BLOCKED = "BOHEMIA_PREPARATION_BLOCKED";

export const isTaskWorkspace = root => root.split(/[\\/]/).some(part =>
  ["spool-work-items", "pr-work-items"].includes(part.toLowerCase()));

export function preparationBlocked(message, reasonCode) {
  return Object.assign(new Error(message), { code: PREPARATION_BLOCKED, reasonCode });
}

export function isAncestor(ancestor, descendant, command) {
  const result = command("git", ["merge-base", "--is-ancestor", ancestor, descendant], undefined, true);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`Cannot establish merge ancestry (${result.code}): ${result.output}`);
}

export function resumeRelationship(remote, head, command) {
  if (remote === head) return "equal";
  if (isAncestor(remote, head, command)) return "ahead";
  if (isAncestor(head, remote, command)) return "behind";
  return "diverged";
}

// Only immutable refs and operation identity affect the compatibility holds.
// File edits cannot turn diverged history into a safe interrupted-merge resume.
export function resumeEvidence(repoRoot, pr, owner) {
  const git = (...args) => execFileSync("git", args, {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
  const gitFile = name => {
    const file = path.resolve(repoRoot, git("rev-parse", "--git-path", name));
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };
  const exists = existsSync(repoRoot);
  const snapshot = {
    exists,
    ...(exists ? {
      head: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"),
      refs: git("for-each-ref", "--format=%(refname) %(objectname)",
        `refs/remotes/origin/${pr.branch}`, `refs/remotes/origin/${pr.targetBranch || "master"}`),
      merge: gitFile("MERGE_HEAD"), orig: gitFile("ORIG_HEAD"),
      rebase: gitFile("rebase-merge/head-name") || gitFile("rebase-apply/head-name"),
      cherryPick: gitFile("CHERRY_PICK_HEAD"), revert: gitFile("REVERT_HEAD"),
      operations: ["rebase-merge", "rebase-apply", "sequencer"].map(name =>
        existsSync(path.resolve(repoRoot, git("rev-parse", "--git-path", name)))),
    } : {}),
    pr: { id: pr.id, url: pr.url, branch: pr.branch, head: pr.sourceCommit,
      target: pr.targetBranch, targetCommit: pr.targetCommit },
    owner: { task: owner.taskId, agent: owner.agent, workspace: owner.workspace, session: owner.task.session_id },
  };
  const hash = createHash("sha256").update(JSON.stringify(snapshot));
  for (const file of ["operations.mjs", "resume-state.mjs"]) {
    hash.update(readFileSync(fileURLToPath(new URL(file, import.meta.url))));
  }
  return hash.digest("hex");
}
