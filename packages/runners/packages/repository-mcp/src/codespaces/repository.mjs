import fs from "node:fs";
import path from "node:path";
import { openCheckout } from "../checkout.mjs";
import { execute, withWorkspaceLock, writeReceipt } from "../process.mjs";
import { repositoryProfile, repositoryEnvironment } from "../adapters/1js-profile.mjs";
import { repositoryAdapter } from "../adapters/1js.mjs";
import { reviewSourcePackageNames } from "./metadata.mjs";

export function codespaceRepositoryAdapter(config, dependencies = {}) {
  if (process.platform !== "linux" && !dependencies.test)
    throw new Error("Full-repository review executes only in its registered Linux Codespace");
  if (config.profile.repoRoot !== "/workspaces/1JS" && !dependencies.test)
    throw new Error("Full-repository review requires the dedicated Codespace checkout");
  const run = dependencies.execute || execute;
  const profile = repositoryProfile(config.profile);
  const canonical = repositoryAdapter(config.profile, { ...dependencies, execute: run });
  const root = profile.repoRoot;
  const state = path.join(root, ".git", "spool-review");
  fs.mkdirSync(state, { recursive: true });
  return {
    id: "1js",
    tools: async () => (await canonical.tools()).map(tool => ({ ...tool,
      description: tool.operation === "pr" ? "Publication is not available in the read-only review Codespace."
        : tool.description })),
    async call(operation, input) {
      if (!["prepare", "build", "check"].includes(operation))
        throw new Error("Review Codespace cannot publish or modify PRs");
      if (input.repoRoot !== root) throw new Error("Remote review checkout is not registered");
      if (operation !== "prepare" || input.operation === "setup" || input.operation === "master")
        return canonical.call(operation, { ...input,
          ...(input.operation === "master" ? { reset: false, mergeMaster: false, runSetup: false, runBuild: false } : {}),
          packages: input.packages || reviewSourcePackageNames(root, config.files) });
      if (input.operation !== "branch" || input.mode !== "checkout" || !input.sourceCommit || input.mergeMaster)
        throw new Error("Remote review requires an exact PR branch checkout without merging");
      return withWorkspaceLock(state, async () => {
        const checkout = await openCheckout(root, { run, env: repositoryEnvironment(profile) });
        const branch = (await canonical.call("prepare", { ...input, baseBranch: "main",
          reset: true, runSetup: false, runBuild: false })).structuredContent;
        if (!branch?.ready || branch.commit !== input.sourceCommit || branch.branch !== input.branch)
          throw new Error("Canonical repository preparation did not verify the requested branch");
        let setup, buildError;
        try {
          setup = (await canonical.call("prepare", { repoRoot: root, operation: "setup",
            packages: reviewSourcePackageNames(root, config.files), runBuild: true })).structuredContent;
          if (!setup?.ready || setup.buildWarmed !== true)
            buildError = "Shared repository preparation did not complete its build";
        } catch (error) {
          buildError = error.message;
        }
        if (await checkout.head() !== branch.commit || await checkout.branch() !== branch.branch ||
            setup && (setup.commit !== branch.commit || setup.branch !== branch.branch || setup.repoRoot !== root))
          throw new Error("Review source changed during shared repository preparation");
        const result = { ...branch, preparationKind: "repository-prepare",
          buildWarmed: !buildError, ...(buildError ? { buildError } : {}),
          steps: [...(branch.steps || []), ...(setup?.steps || [])] };
        writeReceipt(path.join(state, "prepare.json"), result);
        return { content: [{ type: "text", text: `Review branch checked out at ${result.commit}` }],
          structuredContent: result, isError: false };
      });
    },
  };
}
