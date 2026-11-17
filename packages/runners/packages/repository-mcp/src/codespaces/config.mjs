import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const resolveControlWorkspace = root => typeof root === "string" && fs.existsSync(root)
  ? fs.realpathSync.native(root) : undefined;
export function sshInvocation(config, args) {
  if (config.sshHost !== undefined) {
    if (typeof config.sshHost !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(config.sshHost))
      throw new Error("SSH host must be a configured OpenSSH alias");
    return { command: "ssh", args: [...args.slice(0, -1), config.sshHost, args.at(-1)] };
  }
  return { command: "gh", args: ["codespace", "ssh", "-c", config.codespace, "--", ...args] };
}
export const isCodespaceCheckout = root => typeof root === "string" &&
  /^\/workspaces\/[a-zA-Z0-9/_.-]+$/.test(root) && path.posix.normalize(root) === root &&
  !root.endsWith("/") && !root.split("/").includes("..");

export function readCodespaceConfig(file, { validateLocalPaths = true, createWorkspace = false } = {}) {
  if (!path.isAbsolute(file)) throw new Error("Codespace configuration must be an absolute local file");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const allowed = ["version", "codespace", "githubAccount", "connector", "nodeExecutable", "azureCliDirectory",
    "workspace", "remoteRoot", "remoteTools", "nativeProfile", "minimumFreeGiB", "repositoryReview", "purpose", "sshHost",
    "reviewTemplate"];
  if (config.version !== 1 || Object.keys(config).some(key => !allowed.includes(key)))
    throw new Error("Invalid Codespace reviewer configuration");
  if (config.connector === undefined)
    config.connector = fileURLToPath(new URL("./connector/src/connect.ts", import.meta.url));
  for (const key of ["codespace", "githubAccount"]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(config[key] || "")) throw new Error(`Invalid Codespace ${key}`);
  }
  for (const key of ["connector", "nodeExecutable", "workspace", "azureCliDirectory"]) {
    if (!path.isAbsolute(config[key] || ""))
      throw new Error(`Codespace ${key} must be an existing absolute local path (${file}: ${config[key]})`);
    if (validateLocalPaths && !(key === "workspace" && createWorkspace)) {
      try { fs.statSync(config[key]); }
      catch (error) {
        throw new Error(`Codespace ${key} must be an existing absolute local path (${file}: ${config[key]}; ${error.code})`,
          { cause: error });
      }
    }
  }
  const workspace = fs.existsSync(config.workspace)
    ? fs.realpathSync.native(config.workspace) : path.resolve(config.workspace);
  if (config.reviewTemplate !== undefined && (!path.isAbsolute(config.reviewTemplate) ||
      config.purpose !== "review" || validateLocalPaths && !fs.statSync(config.reviewTemplate).isFile()))
    throw new Error("Reviewer checklist must be an existing absolute template file");
  for (const key of ["remoteRoot", "remoteTools"]) {
    if (!/^\/workspaces\/[a-zA-Z0-9/_.-]+$/.test(config[key] || "") ||
        config[key].split("/").includes(".."))
      throw new Error(`Codespace ${key} must be a registered /workspaces path`);
  }
  if (config.remoteRoot === config.remoteTools || config.remoteTools.startsWith(config.remoteRoot + "/"))
    throw new Error("Remote tools must remain outside the reviewed source checkout");
  if (config.remoteRoot !== "/workspaces/1JS" ||
      !config.nativeProfile || config.nativeProfile.repoRoot !== config.remoteRoot ||
      config.nativeProfile.toolchainRoot !== config.remoteRoot || config.nativeProfile.wsl ||
      config.nativeProfile.checkouts || config.nativeProfile.storageRoot !== "/workspaces" ||
      config.nativeProfile.baseBranch !== "main" ||
      typeof config.nativeProfile.nodeExecutable !== "string" ||
      !path.posix.isAbsolute(config.nativeProfile.nodeExecutable) ||
      /[\0\r\n\\]/.test(config.nativeProfile.nodeExecutable))
    throw new Error("A native Linux repository profile for this exact remote checkout is required");
  if (!Number.isFinite(config.minimumFreeGiB) || config.minimumFreeGiB < 1)
    throw new Error("Codespace minimumFreeGiB must be positive");
  const nativeKeys = ["repoRoot", "toolchainRoot", "storageRoot", "baseBranch", "nodeExecutable"];
  if (Object.keys(config.nativeProfile).some(key => !nativeKeys.includes(key)))
    throw new Error("Obsolete local setup settings are not supported in Codespace native profiles");
  if (config.repositoryReview !== undefined && typeof config.repositoryReview !== "boolean")
    throw new Error("Codespace repositoryReview must be boolean");
  if (config.purpose !== undefined && !["review", "engineering"].includes(config.purpose))
    throw new Error("Codespace purpose must be review or engineering");
  if (config.purpose === "engineering" && config.repositoryReview)
    throw new Error("Engineering Codespaces cannot use reviewer configuration");
  if (config.sshHost !== undefined) {
    sshInvocation(config, ["true"]);
    if (!["engineering", "review"].includes(config.purpose))
      throw new Error("SSH hosts require an explicit engineering or review workspace");
  }
  if (validateLocalPaths && createWorkspace) fs.mkdirSync(workspace, { recursive: true });
  return { ...config, file, workspace: validateLocalPaths && createWorkspace
    ? fs.realpathSync.native(workspace) : workspace };
}

export function assertReviewIdentity(pr) {
  if (!Number.isSafeInteger(pr.id) || pr.id < 1 || !/^[a-f0-9]{40}$/i.test(pr.sourceCommit || "") ||
      !/^[a-f0-9]{40}$/i.test(pr.targetCommit || "") || !/^refs\/heads\/[^\s~^:?*[\]\\]+$/.test(pr.sourceBranch || ""))
    throw new Error("Review requires a PR id, exact source/target commits and a source branch");
}

export function assertReviewCoverage(changes) {
  if (!Array.isArray(changes) || !changes.length) throw new Error("PR changed-file inventory is missing");
  const outside = changes.filter(file => typeof file !== "string" || !file || file.startsWith("/") ||
    file.includes("\\") || /[\0\r\n]/.test(file) || path.posix.normalize(file) !== file ||
    file.split("/").some(part => !part || part === ".." || part === ".git"));
  if (outside.length) throw new Error(`PR has invalid repository paths: ${outside.slice(0, 15).join(", ")}`);
}
