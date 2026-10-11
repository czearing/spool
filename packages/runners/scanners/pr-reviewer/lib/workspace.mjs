import { callBohemia } from "../../../packages/bohemia-pr-mcp/src/client.mjs";
import { reviewBuildPackages } from "./dependency-repair.mjs";

export function reviewBranchName(prId, sourceCommit) {
  if (typeof prId === "string" && /^[1-9][0-9]*$/.test(prId)) prId = Number(prId);
  if (!Number.isSafeInteger(prId) || prId < 1) throw new Error("Review requires a valid PR id");
  if (!/^[0-9a-f]{40}$/i.test(sourceCommit || "")) throw new Error("Review requires an exact 40-character source commit");
  return `review/pr-${prId}-${sourceCommit.slice(0, 7)}`;
}

export async function prepareReviewWorkspace({ repoRoot, prId, sourceCommit, call = callBohemia,
  repairDependencies = false, selectPackages = reviewBuildPackages } = {}) {
  const branch = reviewBranchName(prId, sourceCommit);
  const result = await call("bohemia_prepare", {
    repoRoot, operation: "branch", mode: "checkout", branch, sourceCommit,
    reset: false, mergeMaster: false, runSetup: true, runBuild: false,
  });
  if (!result?.ready || result.branch !== branch || result.commit?.toLowerCase() !== sourceCommit.toLowerCase()) {
    throw new Error("Reviewer preparation did not confirm the exact requested revision");
  }
  if (!repairDependencies) return { ...result, sourceCommit };
  const packages = selectPackages(repoRoot);
  const built = await call("bohemia_build", { repoRoot, packages, prepareTests: true });
  if (!built?.ready || built.branch !== branch || built.commit?.toLowerCase() !== sourceCommit.toLowerCase())
    throw new Error("Dependency repair did not confirm the exact requested revision");
  return { ...built, sourceCommit, dependencyRepair: { packages } };
}
