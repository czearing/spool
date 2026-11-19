import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callRepository } from "../client.mjs";
import { repositoryProfile, repositoryEnvironment } from "../adapters/1js-profile.mjs";
import { ensureRepositoryNode } from "../adapters/1js-node.mjs";
import { recoverNativeCodespaceLocks } from "./recovery.mjs";
import { nativeFeedEnvironment } from "./azure-auth.mjs";
import { isCodespaceCheckout } from "./config.mjs";

// This entry runs the existing scoped adapter, not a second install/build recipe.
const request = JSON.parse(process.argv[2] === "--stdin" ? fs.readFileSync(0, "utf8")
  : Buffer.from(process.argv[2], "base64").toString("utf8"));
if (request.engineering
  ? !isCodespaceCheckout(request.profile.repoRoot) ||
    fs.realpathSync(request.profile.repoRoot) !== request.profile.repoRoot
  : request.profile.repoRoot !== "/workspaces/1JS")
  throw new Error("Codespace native entry requires its registered 1JS checkout");
if (!(request.engineering ? ["prepare", "build", "check", "pr"] :
  ["prepare", "build", "check"]).includes(request.operation)) throw new Error("Unsupported remote native operation");
if (request.engineering && request.repositoryReview) throw new Error("Engineering and reviewer routes cannot be combined");
const preserved = recoverNativeCodespaceLocks(request.profile.repoRoot, request.profile.storageRoot,
  request.remoteTools, request.leaseToken);
if (preserved.length) process.stderr.write(`Preserved proved-dead interrupted Codespace locks: ${preserved.join(", ")}\n`);
const selected = await ensureRepositoryNode(repositoryProfile(request.profile));
request.profile = { ...request.profile, nodeExecutable: selected.nodeExecutable };
const environment = repositoryEnvironment(request.profile);
Object.assign(process.env, environment);
process.env.SPOOL_REVIEW_AZURE_AUTH_FILE = request.authFile;
Object.assign(process.env, await nativeFeedEnvironment(process.env));
const bin = path.join(request.remoteTools, "host-auth", "bin");
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, "az"), `#!/bin/sh\nexec ${JSON.stringify(request.profile.nodeExecutable)} ${JSON.stringify(fileURLToPath(new URL("./azure-cli.mjs", import.meta.url)))} "$@"\n`, { mode: 0o700 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const repositoryConfig = `${request.resultFile}.config.json`;
fs.writeFileSync(repositoryConfig, JSON.stringify({ version: 1,
  ...(request.repositoryReview ? { nativeReview: { profile: request.profile, files: request.reviewFiles } }
    : { nativeEngineering: request.profile }) }), { mode: 0o600 });
try {
  const result = await callRepository(request.operation, "1js", request.input, {
    env: { REPOSITORY_MCP_CONFIG: repositoryConfig },
  });
  if (result.isError || !result.structuredContent || !result.structuredContent.ready)
    throw new Error("Remote repository operation did not verify readiness");
  fs.writeFileSync(request.resultFile, JSON.stringify(result.structuredContent), { mode: 0o600 });
} finally {
  fs.rmSync(repositoryConfig, { force: true });
}
