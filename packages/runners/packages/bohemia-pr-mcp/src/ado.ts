import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/// The static Azure DevOps resource id. A token for it is what the REST API accepts.
const DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const API = "api-version=7.1";

export const organization = () =>
  (process.env.BOHEMIA_ADO_ORG || "https://office.visualstudio.com").replace(/\/+$/, "");
export const project = () => process.env.BOHEMIA_ADO_PROJECT || "OC";

let cached: { token: string; expires: number } | undefined;

export async function token(): Promise<string> {
  if (cached && cached.expires > Date.now()) return cached.token;
  const command =
    process.platform === "win32"
      ? { file: "cmd.exe", args: ["/c", "az"] }
      : { file: "az", args: [] as string[] };
  const { stdout } = await run(
    command.file,
    [...command.args, "account", "get-access-token", "--resource", DEVOPS_RESOURCE, "-o", "json"],
    { maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { accessToken: string };
  if (!parsed.accessToken) throw new Error("az returned no access token; run `az login`");
  cached = { token: parsed.accessToken, expires: Date.now() + 45 * 60 * 1000 };
  return parsed.accessToken;
}

async function call(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: { Authorization: ["Be" + "arer", await token()].join(" "), ...(init.headers ?? {}) },
  });
  const contentType = response.headers.get("content-type") || "";
  if ([203, 301, 302, 303, 307, 308, 401, 403].includes(response.status) ||
      (response.ok && contentType && !contentType.includes("json"))) {
    cached = undefined;
    await response.body?.cancel();
    throw Object.assign(new Error(
      `Azure DevOps authentication was rejected (HTTP ${response.status}); restore account access, then reconcile the same PR operation`,
    ), { status: response.status, tokenRejected: true, creationRejected: false });
  }
  const body = await response.text();
  if (!response.ok) {
    let detail: { typeKey?: string } = {};
    try { detail = JSON.parse(body); } catch { /* Non-JSON errors provide no definitive rejection evidence. */ }
    throw Object.assign(new Error(`Azure DevOps ${response.status}: ${body.slice(0, 600)}`), {
      status: response.status, typeKey: detail?.typeKey,
      creationRejected: init.method === "POST" && response.status === 400 &&
        detail?.typeKey === "GitPullRequestCannotBeActivated",
    });
  }
  return body ? JSON.parse(body) : {};
}

const base = (repository: string) =>
  `${organization()}/${project()}/_apis/git/repositories/${encodeURIComponent(repository)}`;

const ref = (branch: string) => (branch.startsWith("refs/") ? branch : `refs/heads/${branch}`);

export type PullRequest = {
  pullRequestId: number;
  title: string;
  description: string;
  url: string;
  sourceRefName?: string;
  targetRefName?: string;
};

export function webUrl(repository: string, pullRequestId: number): string {
  return `${organization()}/${project()}/_git/${encodeURIComponent(repository)}/pullrequest/${pullRequestId}`;
}

export async function createPullRequest(input: {
  repository: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  reviewers?: string[];
  draft?: boolean;
}): Promise<PullRequest> {
  return call(`${base(input.repository)}/pullrequests?${API}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceRefName: ref(input.sourceBranch),
      targetRefName: ref(input.targetBranch),
      title: input.title,
      description: input.description,
      isDraft: Boolean(input.draft),
      ...(input.reviewers?.length ? { reviewers: input.reviewers.map((id) => ({ id })) } : {}),
    }),
  });
}

export async function getPullRequest(repository: string, id: number): Promise<PullRequest> {
  return call(`${base(repository)}/pullrequests/${id}?${API}`, { method: "GET" });
}

export async function listBranchPullRequests(repository: string, branch: string): Promise<PullRequest[]> {
  const result: PullRequest[] = [];
  const pageSize = 100;
  for (let skip = 0; ; skip += pageSize) {
    const page = await call(
      `${base(repository)}/pullrequests?searchCriteria.status=all&searchCriteria.sourceRefName=${encodeURIComponent(ref(branch))}&$top=${pageSize}&$skip=${skip}&${API}`,
      { method: "GET" },
    );
    if (!Array.isArray(page.value)) throw new Error("Invalid pull request list response");
    result.push(...page.value);
    if (page.value.length < pageSize) return result;
  }
}

/// The branch a pull request targets when the caller does not say. A hardcoded literal is a guess
/// that ages badly: office-bohemia is on master, so a "main" default silently targeted a branch
/// that does not exist and left the gate scoping against a missing merge base.
export async function defaultBranch(repository: string): Promise<string> {
  const repo = await call(`${base(repository)}?${API}`, { method: "GET" });
  const name = String(repo.defaultBranch ?? "").replace(/^refs\/heads\//, "");
  if (!name) throw new Error(`${repository} reports no default branch, so pass targetBranch.`);
  return name;
}

/// The commit the source branch points at on the host. Two clones can sit on the same branch at
/// different commits, and only the pushed tip identifies the one the pull request is built from.
export async function branchTip(
  repository: string,
  branch: string,
): Promise<string | undefined> {
  const name = branch.replace(/^refs\/heads\//, "");
  const result = await call(
    `${base(repository)}/refs?filter=heads/${encodeURIComponent(name)}&${API}`,
    { method: "GET" },
  );
  if (!Array.isArray(result?.value)) throw new Error("Invalid branch lookup response");
  return result.value.find((entry: { name?: string }) => entry.name === ref(branch))?.objectId;
}

export async function patchPullRequest(
  repository: string,
  id: number,
  fields: { title?: string; description?: string; targetRefName?: string },
): Promise<PullRequest> {
  return call(`${base(repository)}/pullrequests/${id}?${API}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
}

/// Uploads a local image and returns the host's own URL for it. A machine-local path
/// or a foreign authenticated URL renders for the author alone, so images are only
/// ever embedded through this.
export async function uploadAttachment(
  repository: string,
  pullRequestId: number,
  path: string,
): Promise<string> {
  const bytes = await readFile(path);
  const name = `${Date.now()}-${basename(path)}`.replace(/[^\w.-]/g, "_");
  const uploaded = await call(
    `${base(repository)}/pullRequests/${pullRequestId}/attachments/${encodeURIComponent(name)}?${API}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bytes),
    },
  );
  if (!uploaded.url) throw new Error(`attachment upload for ${path} returned no url`);
  return uploaded.url;
}
