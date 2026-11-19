import { execFileSync } from "node:child_process";
import { requestJson } from "../lib/ado-transport.mjs";
import { reviewerRules, roles } from "./plan.mjs";

const policyFile = ".azuredevops/policies/branchpolicies/master/requiredReviewers.yml";
const reviewerType = "fd2167ab-b0be-447a-8ec8-39368250530e";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const branch = "refs/heads/master";
const git = (repo, ...args) => execFileSync("git", args, {
  cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});

export function nativeReviewerRules(policies, repositoryId) {
  if (!Array.isArray(policies)) throw new Error("Incomplete native reviewer policies");
  return policies.filter(policy => policy.isEnabled && !policy.isDeleted).map(policy => {
    const settings = policy.settings;
    if (policy.type?.id !== reviewerType || typeof policy.isBlocking !== "boolean" ||
        !Array.isArray(settings?.requiredReviewerIds) || !settings.requiredReviewerIds.length ||
        settings.requiredReviewerIds.some(id => !uuid.test(id)) || settings.addedFilesOnly ||
        settings.minimumApproverCount !== undefined && settings.minimumApproverCount !== 1 ||
        !Array.isArray(settings.scope) || !settings.scope.some(scope =>
          (!scope.repositoryId || scope.repositoryId.toLowerCase() === repositoryId.toLowerCase()) &&
          (scope.refName === null || typeof scope.refName === "string" &&
            (scope.matchKind?.toLowerCase() === "exact" && scope.refName.toLowerCase() === branch ||
              scope.matchKind?.toLowerCase() === "prefix" && branch.startsWith(scope.refName.toLowerCase())))) ||
        settings.filenamePatterns !== undefined && (!Array.isArray(settings.filenamePatterns) ||
          settings.filenamePatterns.some(pattern => typeof pattern !== "string" || !pattern.trim() || /[;\r\n\0]/.test(pattern)))) {
      throw new Error("Unsupported native reviewer policy; automatic batching held");
    }
    return {
      branches: `[Ref] ${branch}`, scope: `[Glob] ${(settings.filenamePatterns?.length
        ? settings.filenamePatterns : ["/*"]).join(";")}`, nativePaths: true,
      ...Object.fromEntries(roles.map(role => [role, []])),
      [policy.isBlocking ? "required" : "optional"]: settings.requiredReviewerIds,
    };
  });
}

export async function readReviewerRules(repo, revision, { request = requestJson } = {}) {
  const commit = git(repo, "rev-parse", "--verify", `${revision}^{commit}`).trim();
  if (git(repo, "ls-tree", "--name-only", commit, "--", policyFile).trim())
    return reviewerRules(git(repo, "show", `${commit}:${policyFile}`));
  const remote = new URL(git(repo, "remote", "get-url", "origin").trim());
  if (remote.protocol !== "https:" || !/^(?:dev\.azure\.com|[^.]+\.visualstudio\.com)$/i.test(remote.hostname))
    throw new Error("Native reviewer policies require a verified Azure DevOps repository origin");
  const parts = remote.pathname.split("/").filter(Boolean);
  const organization = remote.hostname.toLowerCase() === "dev.azure.com" ? parts.shift()
    : remote.hostname.split(".")[0];
  if (parts[0]?.toLowerCase() === "defaultcollection") parts.shift();
  if (parts.length !== 3 || parts[1] !== "_git")
    throw new Error("Native reviewer policies require an explicit project and repository");
  const base = `https://dev.azure.com/${encodeURIComponent(organization)}/${parts[0]}`;
  const repository = await request(`${base}/_apis/git/repositories/${parts[2]}?api-version=7.1`);
  if (!uuid.test(repository.id || "")) throw new Error("Native reviewer repository identity is missing");
  const query = new URLSearchParams({ repositoryId: repository.id, refName: branch,
    policyType: reviewerType, "$top": "1000", "api-version": "7.1" });
  const policies = [];
  let cursor = 0;
  for (;;) {
    const page = await request(`${base}/_apis/git/policy/configurations?${query}`);
    if (!Array.isArray(page.value) || page.value.length > 1000)
      throw new Error("Incomplete native reviewer policies");
    policies.push(...page.value);
    if (page.value.length < 1000) break;
    const next = page.value.at(-1).id;
    if (!Number.isSafeInteger(next) || next <= cursor) throw new Error("Native reviewer policy pagination stalled");
    cursor = next; query.set("continuationToken", String(cursor));
  }
  const rules = nativeReviewerRules(policies, repository.id);
  if (!rules.length) throw new Error("No authoritative reviewer ownership policies are available");
  return rules;
}
