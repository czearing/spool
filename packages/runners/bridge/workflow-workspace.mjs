import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifySavedCodespace } from "../packages/repository-mcp/src/codespaces/review.mjs";

const exec = promisify(execFile);
export async function verifyEventWorkspace(prepared, allowChanges = false, execute = exec,
  verifyRemote = verifySavedCodespace) {
  if (!prepared?.ready || !prepared.repoRoot || !prepared.branch || !prepared.commit)
    throw new Error("Event handoff requires verified workspace preparation.");
  if (prepared.execution?.kind === "codespace") {
    if (allowChanges && prepared.execution.purpose !== "engineering")
      throw new Error("Codespace review does not support mutation/publication workflows");
    return verifyRemote(prepared, { allowDirty: allowChanges });
  }
  const wsl = prepared.execution?.kind === "wsl" ? prepared.execution : null;
  if (wsl && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(wsl.distribution || "") ||
      typeof wsl.nativeRepoRoot !== "string" || !wsl.nativeRepoRoot.startsWith("/") || /[\0\r\n]/.test(wsl.nativeRepoRoot)))
    throw new Error("Invalid prepared WSL execution scope.");
  const git = async args => (await execute(wsl ? "wsl.exe" : "git", wsl
    ? ["--distribution", wsl.distribution, "--exec", "git", "-C", wsl.nativeRepoRoot, ...args]
    : ["-C", prepared.repoRoot, ...args],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 })).stdout.trim();
  const [head, branch, changes] = await Promise.all([
    git(["rev-parse", "HEAD"]), git(["symbolic-ref", "--short", "HEAD"]),
    allowChanges ? "" : git(["status", "--porcelain", wsl ? "--untracked-files=normal" : "--untracked-files=no"]),
  ]);
  if (head.toLowerCase() !== prepared.commit.toLowerCase() || branch !== prepared.branch || changes)
    throw new Error("Workflow actions changed the prepared checkout; event handoff held. Inspect the workspace before retrying.");
}
