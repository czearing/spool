/**
 * The watermark. The engine keeps the last commit it observed in the measured repository, and a run
 * compares the current head against it. Nothing wakes an agent to decide whether there is anything to
 * do, because the comparison is a command and the answer is a commit id.
 *
 * Read only against the measured clone: rev-parse and diff, nothing that writes.
 */

import { execFileSync } from "node:child_process";

export function gitHead(repoRoot, { run = execFileSync } = {}) {
  try {
    return (
      String(
        run("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      ).trim() || null
    );
  } catch {
    return null;
  }
}

export function changedPaths({ repoRoot, from, to, run = execFileSync }) {
  if (!from) return null;
  try {
    const output = String(
      run("git", ["diff", "--name-only", `${from}..${to}`], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return null;
  }
}
