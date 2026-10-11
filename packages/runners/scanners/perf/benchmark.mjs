import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digest, readArtifacts } from "./artifacts.mjs";
import { buildProductionArtifacts } from "./build.mjs";

export const rootMetric = "new-office.root.production-brotli-bytes";

export function sourceState(repoRoot) {
  const git = (...args) => execFileSync("git", args, {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000,
  });
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)
    .sort().map(file => [file, digest(readFileSync(path.join(repoRoot, file)))]);
  return {
    repoRoot, commit: git("rev-parse", "HEAD").trim(), branch: git("branch", "--show-current").trim(),
    sourceFingerprint: digest(JSON.stringify({
      status: git("status", "--porcelain"), diff: git("diff", "--binary", "HEAD"), untracked,
    })),
  };
}

export async function benchmark({ repoRoot, call }) {
  repoRoot = path.resolve(repoRoot);
  const before = sourceState(repoRoot);
  await buildProductionArtifacts(before, call);
  const artifacts = readArtifacts(repoRoot);
  if (JSON.stringify(sourceState(repoRoot)) !== JSON.stringify(before)) {
    throw new Error("Checkout changed during the production benchmark; repeat with stable source");
  }
  const value = artifacts.groups.find(group => group.name === "route:__root__").brotliBytes;
  if (!Number.isSafeInteger(value) || artifacts.totals.brotliBytes === null) {
    throw new Error("Benchmark requires verified Brotli sidecars for all included assets");
  }
  return { metric: rootMetric, value, unit: "bytes", ...before, artifacts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--repo-root" || !path.isAbsolute(args[1])) {
      throw new Error("Use --repo-root <absolute-task-checkout>; this command builds production artifacts");
    }
    console.log(JSON.stringify(await benchmark({ repoRoot: args[1] }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
