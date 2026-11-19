import path from "node:path";
import { execute } from "./process.mjs";
import { gitCredentials } from "../../bohemia-pr-mcp/src/git-auth.ts";
import { cleanCommitAttribution } from "./commit-attribution.mjs";

export function branchName(value, name = "branch") {
  if (typeof value !== "string" || !value || value.startsWith("-") ||
      /[\s~^:?*\[\\\x00-\x1f]/.test(value) || value.includes("..") || value.includes("@{") ||
      value.startsWith("/") || value.endsWith("/") || value.endsWith(".") ||
      value.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock")))
    throw new Error(`Invalid ${name}`);
  return value;
}

export function repositoryRemoteIdentity(value) {
  return value.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase()
    .replace(/^https:\/\/([a-z0-9-]+)\.visualstudio\.com\//, "https://dev.azure.com/$1/");
}

export async function openCheckout(repoRoot, { run = execute, authorize = gitCredentials, env = {} } = {}) {
  const gitInput = async (args, options = {}) => (await run("git", ["--no-pager", ...args],
    { ...options, cwd: repoRoot, env: { ...process.env, ...env, ...options.env } })).stdout;
  const git = async (...args) => (await gitInput(args)).trim();
  const prefix = await git("rev-parse", "--show-prefix");
  if (prefix) throw new Error("repoRoot must identify the checkout root");
  const directory = await git("rev-parse", "--absolute-git-dir");
  let credentials;
  const networkGit = async (...args) => {
    credentials ||= authorize(repoRoot);
    const authorized = await credentials;
    return (await run("git", ["--no-pager", ...args], { cwd: repoRoot, env: { ...authorized.environment, ...env }, redactions: authorized.redactions })).stdout.trim();
  };
  return {
    root: repoRoot, directory, git, networkGit,
    cleanCommitAttribution(options) { return cleanCommitAttribution(this, gitInput, options); },
    async clean() {
      if (await git("status", "--porcelain=v1", "--untracked-files=all"))
        throw new Error("Checkout has staged, unstaged or untracked changes; commit or preserve them before publication or switching branches");
    },
    async head() { return git("rev-parse", "HEAD"); },
    async branch() { return git("branch", "--show-current"); },
    async fetch(branch) {
      branchName(branch);
      await networkGit("fetch", "--no-tags", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`);
      return git("rev-parse", `refs/remotes/origin/${branch}`);
    },
    async assertRemote(expected) {
      for (const args of [["remote", "get-url", "--all", "origin"], ["remote", "get-url", "--push", "--all", "origin"]]) {
        const urls = (await git(...args)).split(/\r?\n/);
        if (urls.length !== 1 || repositoryRemoteIdentity(urls[0]) !== repositoryRemoteIdentity(expected))
          throw new Error("Checkout origin and push destination must match the registered repository");
      }
    },
    async changedFiles(target) {
      return (await run("git", ["--no-pager", "diff", "--no-renames", "--name-only", "-z", `${target}...HEAD`], { cwd: repoRoot, env: { ...process.env, ...env } })).stdout.split("\0").filter(Boolean);
    },
    receiptPath(name) { return path.join(directory, "repository-mcp", name); },
  };
}
