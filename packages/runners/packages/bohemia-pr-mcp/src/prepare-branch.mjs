import fs from "node:fs";
import { isAncestor, preparationBlocked, resumeRelationship } from "./resume-state.mjs";
import { recoverPreparedMerge } from "./recover-prepared-merge.mjs";

// Generators can rewrite CRLF as LF without changing Git's canonical content. Refresh only
// those entries; never stage authored content, mode changes, conflicts, or untracked files.
export function refreshUnchanged(command) {
  const status = command("git", ["status", "--porcelain=v1", "-z"]);
  const entries = (status.stdout ?? status.output).split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (/^[RC]|^.[RC]/.test(entry)) { index++; continue; }
    if (!entry.startsWith(" M ")) continue;
    const file = entry.slice(3);
    const diff = command("git", ["--literal-pathspecs", "diff", "--raw", "--no-ext-diff", "--no-textconv", "--", file]);
    if ((diff.stdout ?? diff.output).trim()) continue;
    const blob = command("git", ["rev-parse", `:${file}`]);
    const content = command("git", ["hash-object", `--path=${file}`, "--", file]);
    if ((blob.stdout ?? blob.output).trim() !== (content.stdout ?? content.output).trim()) continue;
    command("git", ["--literal-pathspecs", "add", "--renormalize", "--", file]);
  }
}

export function prepareBranch({ input, root, base, branch, created, previous, git, gitPath, command, stage }) {
  let merge = null;
  git("check-ref-format", "--branch", branch);
  if (input.expectedHead) {
    const remote = git("ls-remote", "--heads", "origin", `refs/heads/${branch}`).split("\t")[0];
    if (remote.toLowerCase() !== input.expectedHead.toLowerCase()) throw new Error("PR head changed before preparation; checkout left untouched");
  }
  let merging = !created && fs.existsSync(gitPath("MERGE_HEAD"));
  if (merging && input.mode === "create" && !input.reset && git("branch", "--show-current") !== branch) {
    recoverPreparedMerge({ previous, root, base, git, gitPath, command, stage });
    merging = false;
  }
  if (!created && !merging) refreshUnchanged(command);
  const dirty = !created && git("status", "--porcelain");
  if (input.mode === "resume") {
    if (git("branch", "--show-current") !== branch) {
      throw preparationBlocked("Resume branch does not match the requested work item; checkout preserved", "branch_mismatch");
    }
    if (["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"]
      .some(name => fs.existsSync(gitPath(name)))) {
      throw preparationBlocked("Another Git operation is in progress; original work preserved");
    }
  }
  if ((dirty || merging) && !input.reset) {
    if (input.mode !== "resume" || !merging) {
      throw new Error("Checkout is dirty; use an explicit fresh reset or resume its existing work");
    }
    if (!input.mergeMaster || input.sourceCommit) {
      throw preparationBlocked("Interrupted merge requires explicit target-branch conflict resume; checkout preserved");
    }
    git("fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      `+refs/heads/${base}:refs/remotes/origin/${base}`);
    const remote = git("rev-parse", `origin/${branch}`);
    if (input.expectedHead && remote.toLowerCase() !== input.expectedHead.toLowerCase()) {
      throw new Error("PR head changed during preparation; checkout left untouched");
    }
    const head = git("rev-parse", "HEAD");
    const relationship = resumeRelationship(remote, head, command);
    if (!["equal", "ahead"].includes(relationship)) {
      throw preparationBlocked(`Interrupted merge is ${relationship} relative to the remote branch; unpublished work preserved`);
    }
    const parents = fs.readFileSync(gitPath("MERGE_HEAD"), "utf8").trim().split(/\s+/);
    if (parents.length !== 1 || git("rev-parse", "ORIG_HEAD") !== head ||
        !isAncestor(parents[0], `origin/${base}`, command)) {
      throw preparationBlocked("Interrupted merge does not match the intended target branch; original work preserved");
    }
    if (!input.allowConflicts && (git("diff", "AUTO_MERGE", "--name-only") ||
        git("diff", "--cached", "AUTO_MERGE", "--name-only", "--diff-filter=ACDMRT") ||
        git("ls-files", "--others", "--exclude-standard"))) throw new Error("Interrupted merge contains authored work; explicit conflict-resume required");
    merge = { merged: true, conflicted: true, resumed: true, relationship,
      targetCommit: parents[0], files: git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean) };
  } else {
    if (input.reset && !created) stage("reset", () => { git("reset", "--hard", "HEAD"); git("clean", "-fd"); });
    stage("branch", () => {
      if (input.mode === "create") {
        git("fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
        const exists = command("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root, true).code === 0;
        if (created) git("checkout", "-B", branch, `origin/${base}`);
        else if (exists) {
          const head = git("rev-parse", branch);
          const ownFailedSetup = previous?.state === "failed" && previous.branch === branch && previous.head === head;
          if (head !== git("rev-parse", `origin/${base}`) && !ownFailedSetup) throw new Error("Branch already contains work; use checkout or resume");
          git("checkout", branch);
          git("merge", "--ff-only", `origin/${base}`);
        } else git("checkout", "-b", branch, `origin/${base}`);
      } else if (input.sourceCommit) {
        git("fetch", "--no-tags", "origin", input.sourceCommit);
        const exists = command("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root, true).code === 0;
        if (exists && git("rev-parse", branch).toLowerCase() !== input.sourceCommit.toLowerCase()) throw new Error("Review branch already names another commit");
        git("checkout", ...(exists ? [branch] : ["-b", branch, "FETCH_HEAD"]));
      } else {
        git("fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
        const exists = command("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root, true).code === 0;
        git("checkout", ...(created ? ["-B", branch, `origin/${branch}`] : exists ? [branch] : ["-b", branch, "--track", `origin/${branch}`]));
        const relationship = resumeRelationship(git("rev-parse", `origin/${branch}`), git("rev-parse", "HEAD"), command);
        if (relationship === "ahead" || relationship === "diverged") {
          if (input.mode !== "resume" || relationship === "diverged") {
            throw preparationBlocked("Unpushed/diverged commits preserved; cannot replace them");
          }
        } else git("merge", "--ff-only", `origin/${branch}`);
      }
    });
    if (input.mergeMaster) merge = stage("merge-master", () => {
      git("fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
      const result = command("git", ["merge", `origin/${base}`], root, true);
      const files = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
      if (result.code !== 0 && (!input.allowConflicts || !files.length)) throw new Error(`Merge failed: ${result.output.slice(-4000)}`);
      return { merged: true, conflicted: files.length > 0, files };
    });
  }
  if (git("branch", "--show-current") !== branch) throw new Error("Prepared branch does not match the request");
  if (input.sourceCommit && git("rev-parse", "HEAD").toLowerCase() !== input.sourceCommit.toLowerCase()) throw new Error("Prepared commit does not match the requested PR revision");
  if (input.mode !== "create" && !input.mergeMaster && (input.sourceCommit || branch !== base)) {
    stage("fetch-master", () => git("fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`));
  }
  stage("base-history", () => git("merge-base", "HEAD", `origin/${base}`));
  return merge;
}
