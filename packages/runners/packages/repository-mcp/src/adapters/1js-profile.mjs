import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const REPOSITORY_REMOTE = "https://dev.azure.com/office/Office/_git/1JS";

export function repositoryProfile(config, root = config.repoRoot) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("1JS repoRoot must be absolute");
  const keys = ["repoRoot", "toolchainRoot", "storageRoot", "baseBranch", "nodeExecutable"];
  if (Object.keys(config).some(key => !keys.includes(key)))
    throw new Error("Unsupported 1JS repository configuration");
  for (const key of ["repoRoot", "storageRoot", "nodeExecutable"])
    if (!path.isAbsolute(config[key] || "")) throw new Error(`1JS ${key} must be absolute`);
  if (path.resolve(root) !== path.resolve(config.repoRoot) ||
      config.toolchainRoot !== undefined && config.toolchainRoot !== config.repoRoot)
    throw new Error("1JS operations require the registered checkout and its private toolchain");
  if (config.baseBranch !== "main") throw new Error("1JS base branch must be main");
  const stateRoot = path.join(config.storageRoot, "workspace-state",
    createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 20));
  return { ...config, repoRoot: root, toolchainRoot: root, workspaceRoot: path.join(root, "midgard"), stateRoot };
}

export function repositoryEnvironment(profile) {
  return { ...process.env,
    SKIP_PRE_COMMIT: "1", SKIP_POST_COMMIT: "1",
    PATH: [path.dirname(profile.nodeExecutable), process.env.PATH].filter(Boolean).join(path.delimiter) };
}

export function assertRepositoryRoot(profile) {
  if (!fs.existsSync(path.join(profile.repoRoot, ".git")) ||
      !fs.existsSync(path.join(profile.workspaceRoot, "package.json")))
    throw new Error("Registered 1JS checkout or Midgard workspace is missing");
}
