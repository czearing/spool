import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mock } from "bun:test";
import type { PullRequest } from "../../../packages/bohemia-pr-mcp/src/ado.ts";

const contextFile = process.env.BOHEMIA_CREATOR_CONTEXT;
assert.ok(contextFile);
const context = JSON.parse(readFileSync(contextFile, "utf8"));
const workspace = context.workspace ?? process.cwd(), branch = context.branch ?? "user/origin";
const source = path.resolve(import.meta.dir, "../../../packages/bohemia-pr-mcp/src");
const records: PullRequest[] = [];
let posts = 0, checks = 0, gateOk = false, notificationFails = false, pushes = 0;
let remoteHead: string | undefined;
let lookupError = false;
let bundleFails = false, bundleChecks = 0, patches = 0;
let pushFails = false, pushReadbackFails = false;
let contentOk = true;
const url = (repository: string, id: number) => `https://example.invalid/${context.taskId}/_git/${repository}/pullrequest/${id}`;
globalThis.fetch = async () => { throw new Error("Unexpected network access in isolated publication test"); };

mock.module(path.join(source, "ado.ts"), () => ({
  token: async () => { throw new Error("Unexpected authentication"); },
  organization: () => "https://example.invalid",
  project: () => "OC",
  createPullRequest: async (input: { repository: string; sourceBranch: string; targetBranch: string; title: string; description: string }) => {
    posts++;
    const pr = { pullRequestId: 123, url: url(input.repository, 123), title: input.title,
      description: input.description, sourceRefName: `refs/heads/${input.sourceBranch}`,
      targetRefName: `refs/heads/${input.targetBranch}`, status: "active" };
    records.push(pr);
    return structuredClone(pr);
  },
  getPullRequest: async () => structuredClone(records[0]),
  listBranchPullRequests: async () => structuredClone(records),
  patchPullRequest: async (_repository: string, _id: number, fields: Partial<PullRequest>) => {
    patches++;
    assert.ok(records[0]);
    Object.assign(records[0], fields);
    return structuredClone(records[0]);
  },
  defaultBranch: async () => "master",
  branchTip: async (_repository: string, name: string) => {
    if (lookupError) throw new Error("fixture branch lookup unavailable");
    return name === "master" ? "c".repeat(40) : remoteHead;
  },
  uploadAttachment: async () => { throw new Error("Unexpected attachment"); },
  webUrl: url,
}));
mock.module(path.join(source, "pr-content.mjs"), () => ({
  assertSubstantiveChanges: (root: string, target: string, head: string) => {
    assert.equal(root, workspace);
    assert.equal(target, "c".repeat(40));
    assert.equal(head, "a".repeat(40));
    if (!contentOk) throw new Error("No substantive changes remain");
  },
}));
mock.module(path.join(source, "gate.ts"), () => ({
  runGate: async (input: { repoRoot?: string }) => {
    checks++;
    if (posts === 0) assert.equal(input.repoRoot, context.workspace || undefined);
    return { ok: gateOk, reasons: gateOk ? [] : ["fixture check failed"], repoRoot: workspace, seconds: 0, headCommit: "a".repeat(40) };
  },
  setupBranch: async () => { throw new Error("Unexpected workspace setup"); },
  pushPublicationBranch: async (root: string, branch: string, _target: string, head: string) => {
    assert.equal(root, workspace);
    assert.equal(branch, context.branch ?? "user/origin");
    assert.ok(gateOk, "A failing gate cannot push");
    if (pushFails) throw new Error("fixture push rejected");
    pushes++;
    if (!pushReadbackFails) remoteHead = head;
  },
}));
mock.module(path.join(source, "identity.ts"), () => ({
  callingAgent: () => "perf", shouldNotify: () => true,
}));
mock.module(path.join(source, "discord.ts"), () => ({
  sendPullRequestLink: async () => {
    if (notificationFails) throw new Error("fixture notification failure");
    return "fixture notification";
  },
}));
mock.module(path.join(source, "bundle-gate.mjs"), () => ({
  prepareBundlePublication: async (options: { repoRoot: string; headCommit: string }) => {
    bundleChecks++;
    assert.equal(options.repoRoot, workspace);
    assert.equal(options.headCommit, "a".repeat(40));
    if (bundleFails) throw new Error("Independent bundle acceptance rejected");
    return null;
  },
  finishBundlePublication: async () => { throw new Error("Legacy task should not claim bundle publication"); },
}));

const { callTool } = await import("../../../packages/bohemia-pr-mcp/src/tools.ts");
const createArgs = { action: "create", repository: "fixture", sourceBranch: branch,
  category: "perf", title: "Faster notebook sidebar render",
  problem: "The notebook sidebar took too long to appear after a page switch.",
  solution: "The sidebar now reuses its measured layout instead of recomputing it on every switch.\n\n| Metric | Before | After |\n| --- | --- | --- |\n| Sidebar render | 412 ms | 138 ms |",
  validation: "Existing sidebar tests were rerun alongside a new render timing check.", uiChange: false };
const invoke = (args: Record<string, unknown>) => callTool({ id: 1, params: { name: "bohemia_pr", arguments: args } });

let result = await invoke(createArgs);
assert.equal(result.result.isError, true);
assert.match(result.result.content[0].text, /fixture check failed/);
assert.equal(posts, 0);
assert.equal(pushes, 0);

lookupError = true;
result = await invoke(createArgs);
assert.equal(result.result.isError, true);
assert.match(result.result.content[0].text, /branch lookup unavailable/);
assert.equal(posts, 0);
assert.equal(pushes, 0);
lookupError = false;

gateOk = true;
contentOk = false;
result = await invoke(createArgs);
assert.equal(result.result.isError, true);
assert.match(result.result.content[0].text, /No substantive changes remain/);
assert.equal(posts, 0);
assert.equal(pushes, 0);
contentOk = true;
bundleFails = true;
result = await invoke({ ...createArgs, category: "fix" });
assert.equal(result.result.isError, true);
assert.match(result.result.content[0].text, /bundle acceptance rejected/);
assert.equal(posts, 0);
assert.equal(pushes, 0);
bundleFails = false;
notificationFails = true;
result = await invoke(createArgs);
assert.equal(result.result.isError, true);
assert.match(result.result.content[0].text, /notification failure/);
assert.equal(posts, 1);
assert.equal(pushes, 1);
const receiptFile = path.join(context.receiptDirectory, `${context.taskId}.json`);
const original = readFileSync(receiptFile, "utf8");
assert.equal(JSON.parse(original).sessionId, context.sessionId);
assert.equal(JSON.parse(original).agent, "perf");

notificationFails = false;
result = await invoke(createArgs);
assert.equal(result.result.isError, false);
assert.equal(posts, 1);
assert.equal(readFileSync(receiptFile, "utf8"), original);

const prefix = records[0]!.description.split("\n")[0];
process.env.COPILOT_SESSION_ID = "00000000-0000-4000-8000-000000000001";
result = await invoke({ action: "update", repository: "fixture", pullRequestId: 123 });
assert.equal(result.result.isError, false);
assert.equal(records[0]!.description.split("\n")[0], prefix);
assert.equal(readFileSync(receiptFile, "utf8"), original);
assert.equal(checks, 6);
assert.equal(posts, 1);
bundleFails = true;
const oldPatches = patches;
result = await invoke({ action: "update", repository: "fixture", pullRequestId: 123, category: "fix" });
assert.equal(result.result.isError, true);
assert.match(result.result.content[0].text, /bundle acceptance rejected/);
assert.equal(patches, oldPatches);
assert.equal(posts, 1);
assert.equal(bundleChecks, 5);
bundleFails = false;
lookupError = true;
result = await invoke({ action: "update", repository: "fixture", pullRequestId: 123 });
assert.equal(result.result.isError, true);
assert.match(result.result.content[0].text, /branch lookup unavailable/);
assert.equal(patches, oldPatches);
lookupError = false;
remoteHead = "b".repeat(40);
pushFails = true;
result = await invoke({ action: "update", repository: "fixture", pullRequestId: 123 });
assert.equal(result.result.isError, true);
assert.match(result.result.content[0].text, /push rejected/);
assert.equal(patches, oldPatches);
pushFails = false;
pushReadbackFails = true;
result = await invoke({ action: "update", repository: "fixture", pullRequestId: 123 });
assert.equal(result.result.isError, true);
assert.match(result.result.content[0].text, /does not match the checked commit/);
assert.equal(patches, oldPatches);
pushReadbackFails = false;
result = await invoke({ action: "update", repository: "fixture", pullRequestId: 123 });
assert.equal(result.result.isError, false);
assert.equal(remoteHead, "a".repeat(40));
assert.equal(patches, oldPatches + 1);
assert.equal(posts, 1);
console.log("Actual publisher entry point: gated creation, durable ownership, retry recovery and immutable update passed");
