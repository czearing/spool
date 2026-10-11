import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function contents(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
}

export async function preparationEvidence(config, cwd) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([config.creatorMinimumFreeGiB, config.creatorWorkspaceSeed]));
  hash.update(await readFile(new URL("../pr-updater/lib/pipeline.mjs", import.meta.url)));
  const shared = new URL("./", import.meta.resolve("bohemia-pr-mcp/client"));
  for (const name of ["operations.mjs", "ci-install.mjs", "ci-install-cli.mjs", "tools.ts", "client.mjs", "yarn-link-recovery.mjs", "preparation-process.mjs", "preparation-capacity.mjs"]) {
    hash.update(await readFile(new URL(name, shared)));
  }
  hash.update(await readFile(new URL("../../dedicated-runners/repo-gates/bohemia.ps1", shared)));
  if (cwd) {
    for (const name of [
      "package.json", "pnpm-lock.yaml", "yarn.lock",
      "node_modules/.ci-install.json",
      ".git/HEAD", ".git/MERGE_HEAD", ".git/AUTO_MERGE",
    ]) {
      hash.update(name);
      const value = await contents(path.join(cwd, ...name.split("/")));
      hash.update(value || "<missing>");
    }
  }
  return hash.digest("hex");
}
