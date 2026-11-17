import fs from "node:fs";
import path from "node:path";
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

export function discardPreparationChanges({ git, gitPath, command }, { generated = false } = {}) {
  git("reset", "--hard", "HEAD");
  if (!generated) command("git", ["clean", "-fd"], undefined, true);
  // Keep generated dependencies, including directories Git clean retains because of ignored children.
  const result = command("git", ["ls-files", "--others", "--exclude-standard", "-z"]);
  const files = (result.stdout ?? result.output).split("\0").filter(Boolean);
  if (files.length) {
    const exclude = gitPath("info/exclude");
    const patterns = files.map(file => `/${file.replace(/[\\*?[\] ]/g, "\\$&")}`);
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `\n${patterns.join("\n")}\n`);
  }
}

export function mergePreparedTarget({ input, root, base, git, command, stage },
  selectedBase = () => `origin/${base}`) {
  return stage("merge-master", () => {
    git("fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
    const target = selectedBase();
    const result = command("git", ["merge", target], root, true);
    const files = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    if (result.code !== 0 && (!input.allowConflicts || !files.length)) throw new Error(`Merge failed: ${result.output.slice(-4000)}`);
    return { merged: true, conflicted: files.length > 0, targetCommit: git("rev-parse", target), files };
  });
}

export function prepareBranch({ input, root, base, branch, created, previous, git, gitPath, command, stage, resetBranch = false }) {
  let merge = null;
  const selectedBase = () => {
    if (!input.baseCommit) return `origin/${base}`;
    if (!isAncestor(input.baseCommit, `origin/${base}`, command))
      throw preparationBlocked("CI baseline is not an ancestor of the fetched target; checkout preserved");
    return input.baseCommit;
  };
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
  const discard = input.reset || dirty && !merging;
  if ((dirty || merging) && !discard) {
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
    if (discard && !created) stage("reset", () => {
      if (resetBranch) {
        if (["rebase-merge", "rebase-apply"].some(name => fs.existsSync(gitPath(name)))) git("rebase", "--abort");
        else if (fs.existsSync(gitPath("CHERRY_PICK_HEAD"))) git("cherry-pick", "--abort");
        else if (fs.existsSync(gitPath("REVERT_HEAD"))) git("revert", "--abort");
      }
      discardPreparationChanges({ git, gitPath, command });
    });
    stage("branch", () => {
      if (input.mode === "create") {
        git("fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
        const exists = command("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root, true).code === 0;
        const start = selectedBase();
        if (created) git("checkout", "-B", branch, start);
        else if (exists) {
          const head = git("rev-parse", branch);
          const ownFailedSetup = previous?.state === "failed" && previous.branch === branch && previous.head === head;
          if (head !== git("rev-parse", start) && !ownFailedSetup) throw new Error("Branch already contains work; use checkout or resume");
          git("checkout", branch);
          if (input.baseCommit && head !== input.baseCommit) {
            if (!ownFailedSetup || !isAncestor(head, `origin/${base}`, command) ||
                git("ls-remote", "--heads", "origin", `refs/heads/${branch}`))
              throw preparationBlocked("Cannot replace authored or published work with a CI baseline; checkout preserved");
            const backup = `refs/repository-mcp/baseline-backups/${head}`;
            const saved = command("git", ["update-ref", backup, head, "0".repeat(40)], root, true);
            if (saved.code !== 0 && git("rev-parse", backup) !== head)
              throw new Error("Cannot preserve the previous failed preparation base");
            git("checkout", "-B", branch, input.baseCommit);
          } else if (!ownFailedSetup) git("merge", "--ff-only", start);
        } else git("checkout", "-b", branch, start);
      } else if (input.sourceCommit) {
        git("fetch", "--no-tags", "origin", input.sourceCommit);
        const exists = command("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root, true).code === 0;
        if (exists && git("rev-parse", branch).toLowerCase() !== input.sourceCommit.toLowerCase()) throw new Error("Review branch already names another commit");
        git("checkout", ...(exists ? [branch] : ["-b", branch, "FETCH_HEAD"]));
      } else {
        git("fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
        if (resetBranch && input.expectedHead &&
            git("rev-parse", `origin/${branch}`).toLowerCase() !== input.expectedHead.toLowerCase())
          throw new Error("PR head changed during preparation; branch restoration held");
        const exists = command("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root, true).code === 0;
        git("checkout", ...(created || resetBranch ? ["-B", branch, `origin/${branch}`] : exists ? [branch] : ["-b", branch, "--track", `origin/${branch}`]));
        const relationship = resumeRelationship(git("rev-parse", `origin/${branch}`), git("rev-parse", "HEAD"), command);
        if (relationship === "ahead" || relationship === "diverged") {
          if (input.mode !== "resume" || relationship === "diverged") {
            throw preparationBlocked("Unpushed/diverged commits preserved; cannot replace them");
          }
        } else git("merge", "--ff-only", `origin/${branch}`);
      }
    });
    if (input.mergeMaster) merge = mergePreparedTarget({ input, root, base, git, command, stage }, selectedBase);
  }
  if (git("branch", "--show-current") !== branch) throw new Error("Prepared branch does not match the request");
  if (input.sourceCommit && git("rev-parse", "HEAD").toLowerCase() !== input.sourceCommit.toLowerCase()) throw new Error("Prepared commit does not match the requested PR revision");
  if (input.mode !== "create" && !input.mergeMaster && (input.sourceCommit || branch !== base)) {
    stage("fetch-master", () => git("fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`));
  }
  stage("base-history", () => git("merge-base", "HEAD", `origin/${base}`));
  return merge;
}
