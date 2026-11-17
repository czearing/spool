import { execute } from "../process.mjs";
import { repositoryEnvironment } from "./1js-profile.mjs";

export async function helperCredentials(profile, run = execute, repoRoot = profile.repoRoot) {
  const environment = repositoryEnvironment(profile);
  await run("git", ["ls-remote", "--exit-code", "origin", "HEAD"], { cwd: repoRoot, env: environment });
  return { environment, redactions: [] };
}

export function repositoryGitCredentials(profile, repoRoot = profile.repoRoot) {
  return helperCredentials(profile, execute, repoRoot);
}
