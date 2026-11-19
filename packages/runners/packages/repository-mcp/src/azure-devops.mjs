import fs from "node:fs/promises";
import path from "node:path";
import { execute as runCommand } from "./process.mjs";

export function azureDevOps({ organization, project, repository }, {
  accessToken, fetcher = fetch, execute = runCommand,
} = {}) {
  const org = organization.replace(/\/+$/, "");
  const base = `${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}`;
  const credential = accessToken || (async () => {
    try {
      const { stdout } = await execute(process.platform === "win32" ? "cmd.exe" : "az", [
        ...(process.platform === "win32" ? ["/d", "/c", "az"] : []),
        "account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798", "-o", "json",
      ]);
      const value = JSON.parse(stdout);
      if (typeof value.accessToken !== "string" || !value.accessToken ||
          !Number.isFinite(Number(value.expires_on)) || Number(value.expires_on) * 1000 <= Date.now())
        throw new Error("Invalid credential");
      return value.accessToken;
    } catch {
      throw new Error("Azure CLI did not return a valid expiring Azure DevOps credential; restore account access and reconcile publication");
    }
  });
  const call = async (suffix, method = "GET", body, contentType = "application/json") => {
    const response = await fetcher(`${base}${suffix}${suffix.includes("?") ? "&" : "?"}api-version=7.1`, {
      method, redirect: "manual",
      headers: { Authorization: `Bearer ${await credential()}`, "Content-Type": contentType },
      ...(body !== undefined ? { body: contentType === "application/json" ? JSON.stringify(body) : body } : {}),
    });
    if (!response.ok || response.status === 203 || !(response.headers.get("content-type") || "").includes("json")) {
      await response.body?.cancel();
      throw new Error(`Azure DevOps ${method} failed (HTTP ${response.status}); reconcile publication before retrying a write`);
    }
    return response.json();
  };
  return {
    async tip(branch) {
      const result = await call(`/refs?filter=heads/${encodeURIComponent(branch)}`);
      if (!Array.isArray(result.value)) throw new Error("Invalid Azure DevOps ref response");
      return result.value.find(ref => ref.name === `refs/heads/${branch}`)?.objectId;
    },
    get: id => call(`/pullrequests/${id}`),
    async list(branch) {
      const result = [];
      for (let skip = 0; ; skip += 100) {
        const page = await call(`/pullrequests?searchCriteria.status=all&searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}&$top=100&$skip=${skip}`);
        if (!Array.isArray(page.value)) throw new Error("Invalid Azure DevOps PR list response");
        result.push(...page.value);
        if (page.value.length < 100) return result;
      }
    },
    create: fields => call("/pullrequests", "POST", fields),
    update: (id, fields) => call(`/pullrequests/${id}`, "PATCH", fields),
    async upload(id, file) {
      const name = `${Date.now()}-${path.basename(file)}`.replace(/[^\w.-]/g, "_");
      const attachment = await call(`/pullRequests/${id}/attachments/${encodeURIComponent(name)}`, "POST", new Uint8Array(await fs.readFile(file)), "application/octet-stream");
      if (!attachment.url) throw new Error("Azure DevOps attachment returned no URL");
      return attachment.url;
    },
    url: id => `${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${id}`,
  };
}
