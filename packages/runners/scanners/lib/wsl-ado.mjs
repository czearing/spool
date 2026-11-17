import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const resource = "499b84ac-1321-427f-aa17-267ca6975798";

export function withWslAdo(config, client, { run = execute } = {}) {
  if (!config.adoWslDistribution) return client;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(config.adoWslDistribution))
    throw new Error("Invalid Azure DevOps WSL distribution");
  let credential, pending;
  const token = async () => {
    if (credential && credential.expires > Date.now() + 60_000) return credential.token;
    pending ||= (async () => {
      const { stdout } = await run("wsl.exe", ["--distribution", config.adoWslDistribution,
        "--exec", "bash", "-lc", 'exec az account get-access-token --resource "$1" --output json',
        "spool-ado", resource], { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout);
      const expires = Number(result.expires_on) * 1000 || Date.parse(result.expiresOn);
      if (!result.accessToken || !Number.isFinite(expires) || expires <= Date.now() + 60_000)
        throw new Error("WSL Azure CLI did not return a current Azure DevOps credential");
      credential = { token: result.accessToken, expires };
      return credential.token;
    })();
    try { return await pending; } finally { pending = null; }
  };
  const optionIndex = { listOwnPullRequests: 1, getPullRequest: 2, getCommit: 2, listThreads: 2,
    listBuilds: 2, requeuePolicy: 2, updateThreadStatus: 4, addThreadComment: 4 };
  return Object.fromEntries(Object.entries(client).map(([name, call]) => {
    if (!Object.hasOwn(optionIndex, name)) throw new Error(`Unknown Azure DevOps client operation: ${name}`);
    return [name, async (...args) => {
      const index = optionIndex[name];
      args[index] = { ...args[index], token: await token() };
      try { return await call(...args); }
      catch (error) {
        if (error.tokenRejected) credential = undefined;
        throw error;
      }
    }];
  }));
}
