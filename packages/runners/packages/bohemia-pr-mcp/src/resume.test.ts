import "./test-environment.ts";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { runOperation } from "./operations.mjs";
import { callBohemia } from "./client.mjs";
import { PREPARATION_BLOCKED, resumeEvidence } from "./resume-state.mjs";
import { createUpdater } from "../../../bridge/updater.mjs";
import { configure } from "../../../bridge/config.mjs";
import { fixture as spoolFixture } from "../../../bridge/test/fixtures.mjs";
import { writeJson } from "../../../bridge/spool-store.mjs";

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}, 30_000);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
}).trim();
const bareGit = (root: string, ...args: string[]) => git(path.dirname(root), `--git-dir=${root}`, ...args);

function fixture(ahead = true) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia-merge-resume-"));
  roots.push(temp);
  const remote = path.join(temp, "origin.git"), seed = path.join(temp, "seed"), root = path.join(temp, "work");
  git(temp, "init", "--bare", "-b", "master", remote);
  git(temp, "clone", remote, seed);
  git(seed, "config", "user.name", "Fixture"); git(seed, "config", "user.email", "fixture@example.invalid");
  for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(seed, name), "base\n");
  git(seed, "add", "."); git(seed, "commit", "-m", "base"); git(seed, "push", "origin", "master");
  git(seed, "checkout", "-b", "topic");
  for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(seed, name), "topic\n");
  git(seed, "add", "."); git(seed, "commit", "-m", "topic"); git(seed, "push", "origin", "topic");
  const remoteHead = git(seed, "rev-parse", "HEAD");
  git(seed, "checkout", "master");
  for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(seed, name), "master\n");
  git(seed, "add", "."); git(seed, "commit", "-m", "master"); git(seed, "push", "origin", "master");
  git(temp, "clone", remote, root); git(root, "checkout", "topic");
  git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  if (ahead) {
    fs.writeFileSync(path.join(root, "repair.txt"), "unpublished repair\n");
    git(root, "add", "."); git(root, "commit", "-m", "unpublished repair");
  }
  const localHead = git(root, "rev-parse", "HEAD");
  const input = { repoRoot: root, operation: "branch", mode: "resume", branch: "topic",
    expectedHead: remoteHead, mergeMaster: true, allowConflicts: true, runSetup: false };
  const first = runOperation("prepare", input);
  expect(first.merge.conflicted).toBe(true);
  fs.writeFileSync(path.join(root, "a.txt"), "staged resolution\n"); git(root, "add", "a.txt");
  fs.writeFileSync(path.join(root, "b.txt"), "unstaged resolution\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "untracked work\n");
  const gate = path.join(temp, "gate.ps1");
  fs.writeFileSync(gate, `param($Action,$RepoRoot,$TargetBranch,[switch]$SkipWarmBuild)
if (Test-Path (Join-Path $RepoRoot '.git\\fail-gate')) { throw 'fixture installation failure' }
@{action=$Action;skip=[bool]$SkipWarmBuild} | ConvertTo-Json -Compress | Add-Content (Join-Path $RepoRoot '.git\\gate-calls.jsonl')
`);
  return { temp, remote, seed, root, input, remoteHead, localHead, gate };
}

function snapshot(root: string) {
  return {
    head: git(root, "rev-parse", "HEAD", "MERGE_HEAD", "ORIG_HEAD"),
    index: git(root, "ls-files", "--stage"),
    staged: git(root, "diff", "--cached", "--binary"),
    files: ["a.txt", "b.txt", "c.txt", "notes.txt"].map(name => fs.readFileSync(path.join(root, name), "utf8")),
  };
}

test("missing isolated checkout has stable evidence until preparation creates it", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia-missing-checkout-"));
  roots.push(temp);
  const root = path.join(temp, "new-workspace");
  const pr = { id: "fixture", branch: "topic", sourceCommit: "a".repeat(40) };
  const owner = { taskId: "original", agent: "software-engineer", workspace: root,
    task: { session_id: "original-session" } };
  const missing = resumeEvidence(root, pr, owner);
  expect(resumeEvidence(root, pr, owner)).toBe(missing);
  expect(fs.existsSync(root)).toBe(false);
  git(temp, "init", "-b", "topic", root);
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "commit", "--allow-empty", "-m", "fixture");
  expect(resumeEvidence(root, pr, owner)).not.toBe(missing);
});

test("unpublished repair plus partially resolved second merge survives repeated shared preparation and actual publication", () => {
  const f = fixture(), before = snapshot(f.root);
  const input = { ...f.input, runSetup: true, runBuild: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = runOperation("prepare", input, { gateScript: f.gate });
    expect(result.ready).toBe(true);
    expect(result.commit).toBe(f.localHead);
    expect(result.merge.resumed).toBe(true);
    expect(result.merge.relationship).toBe("ahead");
    expect(result.merge.files).toEqual(["b.txt", "c.txt"]);
    expect(snapshot(f.root)).toEqual(before);
  }
  const calls = fs.readFileSync(path.join(f.root, ".git", "gate-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.map(call => call.action)).toEqual(["setup", "setup"]);
  expect(calls.every(call => call.skip)).toBe(true);
  for (const name of ["b.txt", "c.txt"]) fs.writeFileSync(path.join(f.root, name), "finished resolution\n");
  git(f.root, "add", "a.txt", "b.txt", "c.txt", "notes.txt");
  git(f.root, "commit", "-m", "finish preserved merge");
  runOperation("check", { repoRoot: f.root }, { gateScript: f.gate });
  git(f.root, "push", "origin", "topic");
  const published = bareGit(f.remote, "rev-parse", "refs/heads/topic");
  expect(published).toBe(git(f.root, "rev-parse", "HEAD"));
  expect(bareGit(f.remote, "show", `${published}:repair.txt`)).toBe("unpublished repair");
  expect(bareGit(f.remote, "show", `${published}:a.txt`)).toBe("staged resolution");
  expect(bareGit(f.remote, "show", `${published}:notes.txt`)).toBe("untracked work");
  bareGit(f.remote, "merge-base", "--is-ancestor", f.localHead, published);
  bareGit(f.remote, "merge-base", "--is-ancestor", "master", published);
}, 60_000);

test("equal remote head and fully staged resolutions still resume the existing merge", () => {
  const f = fixture(false);
  for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(f.root, name), "topic\n");
  git(f.root, "add", "a.txt", "b.txt", "c.txt");
  fs.unlinkSync(path.join(f.root, "notes.txt"));
  expect(git(f.root, "status", "--porcelain")).toBe("");
  const before = fs.readFileSync(path.join(f.root, ".git", "MERGE_HEAD"), "utf8");
  const result = runOperation("prepare", f.input);
  expect(result.merge.resumed).toBe(true);
  expect(result.merge.relationship).toBe("equal");
  expect(result.merge.files).toEqual([]);
  expect(fs.readFileSync(path.join(f.root, ".git", "MERGE_HEAD"), "utf8")).toBe(before);
}, 30_000);

for (const ahead of [false, true]) {
  test(`remote advancement with ${ahead ? "diverged" : "behind"} interrupted work is an explicit non-destructive hold`, () => {
    const f = fixture(ahead), before = snapshot(f.root);
    git(f.seed, "checkout", "topic");
    fs.writeFileSync(path.join(f.seed, "remote-only.txt"), "remote work\n");
    git(f.seed, "add", "."); git(f.seed, "commit", "-m", "advance topic"); git(f.seed, "push", "origin", "topic");
    const expectedHead = git(f.seed, "rev-parse", "HEAD");
    try {
      runOperation("prepare", { ...f.input, expectedHead });
      throw new Error("Expected a compatibility hold");
    } catch (error) {
      expect(error.code).toBe(PREPARATION_BLOCKED);
      expect(error.message).toContain(ahead ? "diverged" : "behind");
    }
    expect(snapshot(f.root)).toEqual(before);
  }, 30_000);
}

test("unrelated merge target, wrong branch and another Git operation are preserved and rejected", () => {
  const f = fixture(), before = snapshot(f.root);
  for (const input of [{ ...f.input, baseBranch: "topic" }, { ...f.input, branch: "master", expectedHead: undefined },
    { ...f.input, mergeMaster: false }]) {
    expect(() => runOperation("prepare", input)).toThrow();
    expect(snapshot(f.root)).toEqual(before);
  }
  fs.writeFileSync(path.join(f.root, ".git", "CHERRY_PICK_HEAD"), f.localHead);
  expect(() => runOperation("prepare", f.input)).toThrow("Another Git operation");
  expect(snapshot(f.root)).toEqual(before);
  expect(fs.readFileSync(path.join(f.root, ".git", "CHERRY_PICK_HEAD"), "utf8")).toBe(f.localHead);
}, 30_000);

test("ancestry command errors are not interpreted as divergence or successful compatibility", () => {
  const f = fixture(), before = snapshot(f.root);
  const execute = (exe: string, args: string[], cwd: string) => {
    if (exe === "git" && args[0] === "merge-base") return { code: 128, output: "fixture object lookup failed" };
    const result = spawnSync(exe, args, { cwd, encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  };
  try { runOperation("prepare", f.input, { execute }); throw new Error("Expected failure"); }
  catch (error) {
    expect(error.message).toContain("object lookup failed");
    expect(error.code).not.toBe(PREPARATION_BLOCKED);
  }
  expect(snapshot(f.root)).toEqual(before);
}, 30_000);

test("remote changing between expected-head check and fetch prevents ready handoff", () => {
  const f = fixture(), before = snapshot(f.root);
  let changed = false;
  const execute = (exe: string, args: string[], cwd: string) => {
    if (!changed && exe === "git" && args[0] === "fetch") {
      changed = true;
      git(f.seed, "checkout", "topic");
      fs.writeFileSync(path.join(f.seed, "later.txt"), "later\n");
      git(f.seed, "add", "."); git(f.seed, "commit", "-m", "race"); git(f.seed, "push", "origin", "topic");
    }
    const result = spawnSync(exe, args, { cwd, encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  };
  expect(() => runOperation("prepare", f.input, { execute })).toThrow("PR head changed during");
  expect(changed).toBe(true);
  expect(snapshot(f.root)).toEqual(before);
}, 30_000);

test("failed installation preserves merge work and never returns a ready checkout", () => {
  const f = fixture(), before = snapshot(f.root);
  fs.writeFileSync(path.join(f.root, ".git", "fail-gate"), "");
  expect(() => runOperation("prepare", { ...f.input, runSetup: true, runBuild: false },
    { gateScript: f.gate })).toThrow("fixture installation failure");
  expect(snapshot(f.root)).toEqual(before);
  const state = JSON.parse(fs.readFileSync(path.join(f.root, ".git", "bohemia-preparation.json"), "utf8"));
  expect(state.state).toBe("failed");
  expect(state.stage).toBe("setup");
}, 30_000);

test("real MCP transport preserves structured compatibility holds", async () => {
  const f = fixture();
  try {
    await callBohemia("bohemia_prepare", { ...f.input, baseBranch: "topic" });
    throw new Error("Expected a compatibility hold");
  } catch (error) {
    expect(error.code).toBe(PREPARATION_BLOCKED);
    expect(error.message).toContain("intended target branch");
  }
}, 30_000);

test("real MCP transport exposes a typed branch mismatch without changing the checkout", async () => {
  const f = fixture(), before = snapshot(f.root);
  try {
    await callBohemia("bohemia_prepare", { ...f.input, branch: "master", expectedHead: undefined });
    throw new Error("Expected branch mismatch");
  } catch (error) {
    expect(error.code).toBe(PREPARATION_BLOCKED);
    expect(error.reasonCode).toBe("branch_mismatch");
  }
  expect(snapshot(f.root)).toEqual(before);
}, 30_000);

test("hold evidence changes for relevant remote, local and owner identity changes", () => {
  const f = fixture();
  const pr = { id: "1", url: "https://example.invalid/pr/1", branch: "topic", sourceCommit: f.remoteHead, targetBranch: "master" };
  const owner = { taskId: "original", agent: "perf", workspace: f.root, task: { session_id: "session" } };
  const before = resumeEvidence(f.root, pr, owner);
  expect(resumeEvidence(f.root, pr, owner)).toBe(before);
  const unrelatedRefs = Array.from({ length: 12_000 }, (_, i) =>
    `${f.localHead} refs/remotes/origin/unrelated-${"x".repeat(55)}-${i}`).join("\n");
  const existingRefs = git(f.root, "for-each-ref", "--format=%(objectname) %(refname)");
  fs.writeFileSync(path.join(f.root, ".git", "packed-refs"), `# pack-refs with: peeled\n${existingRefs}\n${unrelatedRefs}\n`);
  const allRefs = execFileSync("git", ["show-ref"], { cwd: f.root, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  expect(allRefs.length).toBeGreaterThan(1024 * 1024);
  expect(resumeEvidence(f.root, pr, owner)).toBe(before);
  expect(resumeEvidence(f.root, { ...pr, sourceCommit: "a".repeat(40) }, owner)).not.toBe(before);
  expect(resumeEvidence(f.root, { ...pr, targetCommit: "b".repeat(40) }, owner)).not.toBe(before);
  expect(resumeEvidence(f.root, pr, { ...owner, task: { session_id: "different" } })).not.toBe(before);
  fs.writeFileSync(path.join(f.root, ".git", "CHERRY_PICK_HEAD"), f.localHead);
  expect(resumeEvidence(f.root, pr, owner)).not.toBe(before);
}, 60_000);

test("normal updater hands a real interrupted merge to its original creator once, preserving its session and all work", async () => {
  const f = fixture(), before = snapshot(f.root);
  const spool = spoolFixture({ after: (cleanup: () => void) => cleanups.push(cleanup) });
  const taskId = "OFF-fixture", session = "original-provider-session";
  spool.put({ id: taskId, agent: "perf", workspace: f.root, session_id: session }, "failed");
  const pr = { id: "123", url: "https://example.invalid/fixture/pullrequest/123", branch: "topic",
    targetBranch: "master", targetCommit: git(f.root, "rev-parse", "origin/master"),
    sourceCommit: f.remoteHead, status: "active", mergeStatus: "conflicts", votes: [], reviewers: [], description: "" };
  writeJson(path.join(spool.store.records, "ownership.json"), { version: 1, verificationPrIds: ["999"], pullRequests: [{
    verified: true, prId: pr.id, prUrl: pr.url, branch: pr.branch, taskId, agent: "perf",
    workspace: f.root, sessionId: session, creatorName: "Original creator",
  }] });
  const { config } = configure({ spool_dir: spool.root, pr_updater: { enabled: true, workspace_dir: f.root } },
    "pr-updater", spool.root);
  config.creatorMinimumFreeGiB = 0.001;
  let preparations = 0;
  const options = { store: spool.store, config, agent: "pr-updater", workspace: f.root, runtime: config.runtimeDirectory,
    ado: { async listOwnPullRequests() { return [pr]; }, async getPullRequest() { return pr; },
      async listThreads() { return []; }, async listBuilds() { return []; } },
    callBohemia: async (name: string, args: object) => {
      expect(name).toBe("bohemia_prepare"); preparations++;
      return runOperation("prepare", args, { gateScript: f.gate });
    },
  };
  expect((await (await createUpdater(options))()).dispatched).toBe(1);
  expect(snapshot(f.root)).toEqual(before);
  const task = spool.store.task(taskId);
  expect(task.agent).toBe("perf");
  expect(task.workspace).toBe(f.root);
  expect(task.session_id).toBe(session);
  expect(task.status).toBe("incoming");
  expect(spool.store.metadata(taskId).preparation.merge.relationship).toBe("ahead");
  expect((await (await createUpdater(options))()).dispatched).toBe(0);
  expect(preparations).toBe(1);
  expect(spool.store.tasks()).toHaveLength(1);
}, 45_000);
