import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export async function verifyEventWorkspace(prepared, allowChanges = false) {
  if (!prepared?.ready || !prepared.repoRoot || !prepared.branch || !prepared.commit)
    throw new Error("Event handoff requires verified workspace preparation.");
  const git = async args => (await exec("git", ["-C", prepared.repoRoot, ...args],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 })).stdout.trim();
  const [head, branch, changes] = await Promise.all([
    git(["rev-parse", "HEAD"]), git(["symbolic-ref", "--short", "HEAD"]),
    allowChanges ? "" : git(["status", "--porcelain", "--untracked-files=no"]),
  ]);
  if (head.toLowerCase() !== prepared.commit.toLowerCase() || branch !== prepared.branch || changes)
    throw new Error("Workflow actions changed the prepared checkout; event handoff held. Inspect the workspace before retrying.");
}
