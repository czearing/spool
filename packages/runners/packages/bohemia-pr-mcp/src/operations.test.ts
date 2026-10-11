import { testHome } from "./test-environment.ts";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { runOperation, validateOperation } from "./operations.mjs";
import { callBohemia } from "./client.mjs";
import { callTool } from "./tools.ts";
import { gitCredentials } from "./git-auth.ts";
import { runGate } from "./gate.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test("retired per-task checkouts cannot be prepared or recreated by stale callers", () => {
  for (const directory of ["spool-work-items", "pr-work-items", "SPOOL-WORK-ITEMS"]) {
    const repoRoot = path.join(os.tmpdir(), directory, "fixture-retired");
    for (const operation of ["setup", "branch"]) {
      let invoked = false;
      expect(() => runOperation("prepare", { repoRoot, operation, branch: "fixture",
        seedRoot: os.tmpdir() }, { execute() { invoked = true; throw new Error("Unexpected Git operation"); } }))
        .toThrow("Task-specific checkouts are retired");
      expect(invoked).toBe(false);
    }
    expect(() => validateOperation("build", { repoRoot })).not.toThrow();
    expect(() => validateOperation("check", { repoRoot })).not.toThrow();
  }
});

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia-operation-"));
  roots.push(temp);
  const remote = path.join(temp, "remote");
  const root = path.join(temp, "clone");
  fs.mkdirSync(remote);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(remote, "init", "-b", "master");
  git(remote, "config", "user.email", "fixture@example.invalid");
  git(remote, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(remote, "tracked.txt"), "base\n");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "initial");
  git(temp, "clone", remote, root);
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  const commit = git(root, "rev-parse", "HEAD");
  const input = { repoRoot: root, operation: "branch", branch: "topic", mode: "create", runSetup: false };
  const gate = path.join(temp, "gate.ps1");
  fs.writeFileSync(gate, `param($Action,$RepoRoot,$TargetBranch,$Packages,[switch]$SkipWarmBuild,[switch]$ProductionArtifacts,[switch]$PrepareTests)
@{action=$Action;packages=$Packages;skip=[bool]$SkipWarmBuild;productionArtifacts=[bool]$ProductionArtifacts;prepareTests=[bool]$PrepareTests} | ConvertTo-Json -Compress | Add-Content (Join-Path $RepoRoot '.git\\gate-calls.jsonl')
if (Test-Path (Join-Path $RepoRoot '.git\\fail-gate')) { Write-Output 'fixture gate failed'; exit 17 }
exit 0
`);
  return { temp, remote, root, git, commit, input, gate };
}

test("fresh branch uses fetched master and persists completion", () => {
  const f = fixture();
  const result = runOperation("prepare", f.input);
  expect(result.ready).toBe(true);
  expect(result.commit).toBe(f.commit);
  expect(f.git(f.root, "branch", "--show-current")).toBe("topic");
  expect(JSON.parse(fs.readFileSync(path.join(f.root, ".git", "bohemia-preparation.json"), "utf8")).state).toBe("completed");
  expect(fs.existsSync(path.join(f.root, ".git", "bohemia-workspace.lock"))).toBe(false);
});

test("existing PR preparation restores the target ref in a branch-only checkout", () => {
  const f = fixture();
  f.git(f.remote, "checkout", "-b", "topic");
  fs.writeFileSync(path.join(f.remote, "topic.txt"), "PR work\n");
  f.git(f.remote, "add", ".");
  f.git(f.remote, "commit", "-m", "PR work");
  const head = f.git(f.remote, "rev-parse", "HEAD");
  f.git(f.remote, "checkout", "master");
  f.git(f.root, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/topic:refs/remotes/origin/topic");
  f.git(f.root, "update-ref", "-d", "refs/remotes/origin/master");
  const result = runOperation("prepare", { ...f.input, mode: "checkout", expectedHead: head });
  expect(result.ready).toBe(true);
  expect(f.git(f.root, "rev-parse", "HEAD")).toBe(head);
  expect(f.git(f.root, "merge-base", "HEAD", "origin/master")).toBe(f.commit);
  f.git(f.root, "update-ref", "-d", "refs/remotes/origin/master");
  expect(runOperation("prepare", { ...f.input, mode: "resume" }).ready).toBe(true);
  expect(f.git(f.root, "merge-base", "HEAD", "origin/master")).toBe(f.commit);
}, 30_000);

test("preparation refuses missing target ancestry before setup or a ready handoff", () => {
  const f = fixture();
  expect(() => runOperation("prepare", { ...f.input, runSetup: true }, {
    gateScript: f.gate,
    execute(exe: string, args: string[], cwd: string) {
      if (exe === "git" && args.join(" ") === "merge-base HEAD origin/master") {
        return { code: 1, output: "fixture has no shared target ancestry" };
      }
      const result = spawnSync(exe, args, { cwd, encoding: "utf8", windowsHide: true });
      if (result.error) throw result.error;
      return { code: result.status ?? 1, output: `${result.stdout || ""}${result.stderr || ""}` };
    },
  })).toThrow("fixture has no shared target ancestry");
  expect(fs.existsSync(path.join(f.root, ".git", "gate-calls.jsonl"))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(f.root, ".git", "bohemia-preparation.json"), "utf8")))
    .toMatchObject({ state: "failed", stage: "base-history" });
});

test("publication pushes only an unchanged checked commit and never bypasses a failing gate", () => {
  const f = fixture();
  runOperation("prepare", f.input);
  fs.writeFileSync(path.join(f.root, ".git", "fail-gate"), "");
  const input = { repoRoot: f.root, branch: "topic", expectedHead: f.commit, baseBranch: "master" };
  expect(() => runOperation("push", input, { gateScript: f.gate })).toThrow("fixture gate failed");
  expect(f.git(f.root, "ls-remote", "--heads", "origin", "refs/heads/topic")).toBe("");
  fs.unlinkSync(path.join(f.root, ".git", "fail-gate"));
  expect(() => runOperation("push", { ...input, expectedHead: "a".repeat(40) }, { gateScript: f.gate })).toThrow("checkout changed");
  const result = runOperation("push", input, { gateScript: f.gate });
  expect(result.commit).toBe(f.commit);
  expect(f.git(f.root, "ls-remote", "--heads", "origin", "refs/heads/topic").split("\t")[0]).toBe(f.commit);
}, 30_000);

test("production artifacts use the canonical build gate and require an explicit scope", async () => {
  const f = fixture();
  expect(() => validateOperation("build", { repoRoot: f.root, productionArtifacts: true })).toThrow("explicit packages");
  expect(() => validateOperation("prepare", { ...f.input, productionArtifacts: true, packages: ["@fluidx/new-office"] })).toThrow("bohemia_build");
  const result = await callBohemia("bohemia_build", {
    repoRoot: f.root, packages: ["@fluidx/new-office"], productionArtifacts: true,
  }, { env: { USERPROFILE: testHome, HOME: testHome, BOHEMIA_GATE_SCRIPT: f.gate } });
  expect(result.productionArtifacts).toBe(true);
  const calls = fs.readFileSync(path.join(f.root, ".git", "gate-calls.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ action: "build", packages: "@fluidx/new-office", productionArtifacts: true });
}, 30_000);

test("test runtime repair uses the canonical locked build and cannot hide a failed gate", async () => {
  const f = fixture(), input = { repoRoot: f.root, packages: ["@fixture/runtime"], prepareTests: true };
  expect(() => validateOperation("build", { ...input, packages: [] })).toThrow("explicit packages");
  expect(() => validateOperation("prepare", { ...f.input, ...input })).toThrow("dependency build");
  expect(() => validateOperation("build", { ...input, productionArtifacts: true })).toThrow("productionArtifacts");
  const result = await callBohemia("bohemia_build", input,
    { env: { USERPROFILE: testHome, HOME: testHome, BOHEMIA_GATE_SCRIPT: f.gate } });
  expect(result.ready).toBe(true);
  const calls = fs.readFileSync(path.join(f.root, ".git", "gate-calls.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
  expect(calls).toEqual([{ action: "build", packages: "@fixture/runtime", skip: false, productionArtifacts: false, prepareTests: true }]);
  fs.writeFileSync(path.join(f.root, ".git", "fail-gate"), "");
  expect(() => runOperation("build", input, { gateScript: f.gate })).toThrow("fixture gate failed");
}, 30_000);

test("test setup cannot report an exact-revision review workspace after modifying source", () => {
  const f = fixture();
  fs.writeFileSync(f.gate, `param($Action,$RepoRoot,$Packages,[switch]$PrepareTests)
Set-Content -LiteralPath (Join-Path $RepoRoot 'tracked.txt') -Value 'modified by test setup'
exit 0
`);
  expect(() => runOperation("build", { repoRoot: f.root, packages: ["@fixture/runtime"], prepareTests: true },
    { gateScript: f.gate })).toThrow("dirty review handoff");
  expect(fs.readFileSync(path.join(f.root, "tracked.txt"), "utf8")).toContain("modified by test setup");
});

test("PR publication uses the shared check gate with one origin prefix and propagates failures", async () => {
  const f = fixture();
  fs.writeFileSync(f.gate, `param($Action,$RepoRoot,$TargetBranch)
if ($Action -ne 'check' -or $TargetBranch -ne 'origin/master') { throw "Wrong check arguments: $Action $TargetBranch" }
git -C $RepoRoot show-ref --verify refs/remotes/origin/master | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Missing target ref after publication refresh' }
if (Test-Path (Join-Path $RepoRoot '.git\\fail-gate')) { Write-Output 'fixture publication gate failed'; exit 17 }
exit 0
`);
  const previous = process.env.BOHEMIA_GATE_SCRIPT;
  process.env.BOHEMIA_GATE_SCRIPT = f.gate;
  try {
    const input = { repository: "remote", sourceBranch: "master", targetBranch: "refs/heads/master",
      headCommit: f.commit, workingDirectory: f.root, environment: {} };
    expect((await runGate(input)).ok).toBe(true);
    f.git(f.root, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/topic:refs/remotes/origin/topic");
    f.git(f.root, "update-ref", "-d", "refs/remotes/origin/master");
    expect((await runGate({ ...input, repoRoot: f.root, workingDirectory: f.temp })).ok).toBe(true);
    fs.writeFileSync(path.join(f.root, ".git", "fail-gate"), "");
    const rejected = await runGate(input);
    expect(rejected.ok).toBe(false);
    expect(rejected.reasons.join("\n")).toContain("fixture publication gate failed");
  } finally {
    if (previous === undefined) delete process.env.BOHEMIA_GATE_SCRIPT;
    else process.env.BOHEMIA_GATE_SCRIPT = previous;
  }
}, 30_000);

test("publication validates unpushed fast-forwards but rejects stale and diverged clones", async () => {
  const f = fixture();
  runOperation("prepare", f.input);
  f.git(f.root, "push", "origin", "topic");
  fs.writeFileSync(path.join(f.root, "local.txt"), "local change\n");
  f.git(f.root, "add", "."); f.git(f.root, "commit", "-m", "local work");
  const ahead = f.git(f.root, "rev-parse", "HEAD");
  const previous = process.env.BOHEMIA_GATE_SCRIPT;
  process.env.BOHEMIA_GATE_SCRIPT = f.gate;
  try {
    const input = { repository: "remote", sourceBranch: "topic", targetBranch: "master",
      repoRoot: f.root, headCommit: f.commit };
    const accepted = await runGate(input);
    expect(accepted.ok).toBe(true);
    expect(accepted.headCommit).toBe(ahead);
    expect(f.git(f.root, "ls-remote", "--heads", "origin", "topic").split("\t")[0]).toBe(f.commit);
    f.git(f.remote, "checkout", "topic");
    fs.writeFileSync(path.join(f.remote, "remote.txt"), "remote change\n");
    f.git(f.remote, "add", "."); f.git(f.remote, "commit", "-m", "remote work");
    f.git(f.root, "fetch", "origin");
    const diverged = await runGate({ ...input, headCommit: f.git(f.remote, "rev-parse", "HEAD") });
    expect(diverged.ok).toBe(false);
    expect(diverged.reasons.join()).toContain("fast-forward");
    const calls = fs.readFileSync(path.join(f.root, ".git", "gate-calls.jsonl"), "utf8").trim().split(/\r?\n/);
    expect(calls).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env.BOHEMIA_GATE_SCRIPT;
    else process.env.BOHEMIA_GATE_SCRIPT = previous;
  }
}, 30_000);

test("publication refuses a HEAD rewritten by validation even when its worktree is clean", async () => {
  const f = fixture();
  fs.writeFileSync(f.gate, `param($Action,$RepoRoot,$TargetBranch)
git -C $RepoRoot -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -m changed-by-gate | Out-Null
exit $LASTEXITCODE
`);
  const previous = process.env.BOHEMIA_GATE_SCRIPT;
  process.env.BOHEMIA_GATE_SCRIPT = f.gate;
  try {
    const outcome = await runGate({ repository: "remote", sourceBranch: "master", targetBranch: "master",
      repoRoot: f.root, headCommit: f.commit });
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons.join()).toContain("HEAD changed");
  } finally {
    if (previous === undefined) delete process.env.BOHEMIA_GATE_SCRIPT;
    else process.env.BOHEMIA_GATE_SCRIPT = previous;
  }
}, 30_000);

test("repository gates own their deadlines while other commands retain the transport backstop", () => {
  const f = fixture(), calls: { exe: string; timeout: number }[] = [];
  expect(() => runOperation("prepare", { repoRoot: f.root, operation: "setup", runBuild: false }, {
    gateScript: f.gate,
    execute(exe: string, args: string[], cwd: string, timeout: number) {
      calls.push({ exe, timeout });
      return exe === "pwsh" ? { code: 124, output: "repository gate timed out and cleaned up its process tree" }
        : { code: 0, output: f.git(cwd, ...args) };
    },
  })).toThrow("repository gate timed out");
  expect(calls.filter(call => call.exe === "pwsh").map(call => call.timeout)).toEqual([0]);
  expect(calls.filter(call => call.exe === "git").every(call => call.timeout === 5_400_000)).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(f.root, ".git", "bohemia-preparation.json"), "utf8")).state).toBe("failed");
  expect(fs.existsSync(path.join(f.root, ".git", "bohemia-workspace.lock"))).toBe(false);
});

test("master refresh neither switches branch nor discards local changes", () => {
  const f = fixture();
  runOperation("prepare", f.input);
  fs.writeFileSync(path.join(f.root, "tracked.txt"), "local edit\n");
  fs.writeFileSync(path.join(f.remote, "new.txt"), "new master\n");
  f.git(f.remote, "add", "."); f.git(f.remote, "commit", "-m", "advance master");
  runOperation("prepare", { repoRoot: f.root, operation: "master" });
  expect(f.git(f.root, "branch", "--show-current")).toBe("topic");
  expect(f.git(f.root, "rev-parse", "HEAD")).toBe(f.commit);
  expect(f.git(f.root, "rev-parse", "origin/master")).toBe(f.git(f.remote, "rev-parse", "HEAD"));
  expect(fs.readFileSync(path.join(f.root, "tracked.txt"), "utf8")).toBe("local edit\n");
});

test("dirty checkout is preserved unless fresh reset is explicit", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, "tracked.txt"), "authored edit\n");
  fs.writeFileSync(path.join(f.root, "untracked.txt"), "authored new file\n");
  expect(() => runOperation("prepare", f.input)).toThrow("dirty");
  expect(fs.existsSync(path.join(f.root, "untracked.txt"))).toBe(true);
  runOperation("prepare", { ...f.input, reset: true });
  expect(f.git(f.root, "status", "--porcelain")).toBe("");
  expect(fs.existsSync(path.join(f.root, "untracked.txt"))).toBe(false);
});

test("exact review remains pinned after master advances", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.remote, "new.txt"), "later\n");
  f.git(f.remote, "add", "."); f.git(f.remote, "commit", "-m", "later");
  const result = runOperation("prepare", { ...f.input, mode: "checkout", branch: "review/pr-1-revision", sourceCommit: f.commit });
  expect(result.commit).toBe(f.commit);
  expect(() => runOperation("prepare", { ...f.input, mode: "checkout", sourceCommit: f.commit, mergeMaster: true })).toThrow("Exact-revision");
});

test("changed remote head refuses reset before touching authored files", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, "untracked.txt"), "keep");
  expect(() => runOperation("prepare", { ...f.input, branch: "master", mode: "checkout", expectedHead: "a".repeat(40), reset: true })).toThrow("PR head changed");
  expect(fs.readFileSync(path.join(f.root, "untracked.txt"), "utf8")).toBe("keep");
});

test("resume preserves unpushed commits; checkout will not overwrite them", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, "tracked.txt"), "local commit\n");
  f.git(f.root, "add", "."); f.git(f.root, "commit", "-m", "local work");
  const local = f.git(f.root, "rev-parse", "HEAD");
  const input = { ...f.input, branch: "master", mode: "checkout" };
  expect(() => runOperation("prepare", input)).toThrow("Unpushed");
  expect(runOperation("prepare", { ...input, mode: "resume" }).commit).toBe(local);
  expect(() => runOperation("prepare", { ...input, mode: "resume", reset: true })).toThrow("Reset");
  fs.writeFileSync(path.join(f.remote, "remote-only.txt"), "remote change\n");
  f.git(f.remote, "add", "."); f.git(f.remote, "commit", "-m", "remote work");
  expect(() => runOperation("prepare", { ...input, mode: "resume" })).toThrow("Unpushed/diverged");
  expect(f.git(f.root, "rev-parse", "HEAD")).toBe(local);
});

test("setup/build/check use one gate and repair can install without requiring a passing build", () => {
  const f = fixture();
  runOperation("prepare", { ...f.input, runSetup: true, runBuild: false }, { gateScript: f.gate });
  runOperation("build", { repoRoot: f.root, packages: ["@fixture/tools"] }, { gateScript: f.gate });
  runOperation("check", { repoRoot: f.root }, { gateScript: f.gate });
  const calls = fs.readFileSync(path.join(f.root, ".git", "gate-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.map(call => call.action)).toEqual(["setup", "build", "check"]);
  expect(calls[0].skip).toBe(true);
  expect(calls[1].packages).toBe("@fixture/tools");
});

test("failed setup is never ready and retains failure evidence", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, ".git", "fail-gate"), "");
  expect(() => runOperation("prepare", { ...f.input, runSetup: true }, { gateScript: f.gate })).toThrow("fixture gate failed");
  expect(JSON.parse(fs.readFileSync(path.join(f.root, ".git", "bohemia-preparation.json"), "utf8")).state).toBe("failed");
});

test("concurrent preparation is refused without modifying the checkout", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, ".git", "bohemia-workspace.lock"), JSON.stringify({ pid: process.pid }));
  expect(() => runOperation("prepare", f.input)).toThrow();
  expect(f.git(f.root, "branch", "--show-current")).toBe("master");
});

test("argument validation rejects shell fragments and non-root directories", () => {
  const f = fixture();
  expect(() => runOperation("build", { repoRoot: f.root, packages: ["x;exit"] })).toThrow("valid package");
  expect(() => runOperation("prepare", { ...f.input, branch: "--orphan" })).toThrow("Invalid branch");
  const child = path.join(f.root, "child"); fs.mkdirSync(child);
  expect(() => runOperation("prepare", { ...f.input, repoRoot: child })).toThrow("checkout root");
});

test("ADO credentials stay in scoped Git environment, not arguments", async () => {
  const f = fixture();
  f.git(f.root, "remote", "set-url", "origin", "https://dev.azure.com/office/OC/_git/fixture");
  const result = await gitCredentials(f.root, async () => "fixture-secret");
  expect(result.environment.GIT_TERMINAL_PROMPT).toBe("0");
  expect(Object.values(result.environment)).toContain("http.https://dev.azure.com/office/.extraHeader");
  expect(result.redactions).toContain("fixture-secret");
});

test("real MCP client crosses the transport and fresh worker before confirming preparation", async () => {
  const f = fixture();
  const result = await callBohemia("bohemia_prepare", { ...f.input, runSetup: true }, { env: { BOHEMIA_GATE_SCRIPT: f.gate } });
  expect(result.ready).toBe(true);
  expect(result.branch).toBe("topic");
  expect(fs.existsSync(path.join(f.root, ".git", "gate-calls.jsonl"))).toBe(true);
  const records = fs.readFileSync(path.join(testHome, ".bohemia-gate", "mcp-runs.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  expect(records.some(record => record.args?.repoRoot === f.root && record.success &&
    record.sessionId === process.env.COPILOT_SESSION_ID)).toBe(true);
}, 30_000);

test("combined PR tool enforces action-specific fields before publication", async () => {
  for (const args of [
    { action: "delete", repository: "fixture" },
    { action: "create", repository: "fixture" },
    { action: "update", repository: "fixture" },
    { action: "update", repository: "fixture", pullRequestId: 1, sourceBranch: "unexpected" },
  ]) {
    const reply = await callTool({ id: 1, params: { name: "bohemia_pr", arguments: args } });
    expect(reply.result.isError).toBe(true);
  }
});

test("invalid PR target updates are refused before any publication work", async () => {
  for (const targetBranch of ["", " ", "refs/heads/", "origin/", "refs/heads/origin/", 123]) {
    const reply = await callTool({
      id: 1,
      params: {
        name: "bohemia_pr",
        arguments: { action: "update", repository: "remote", pullRequestId: 1, targetBranch },
      },
    });
    expect(JSON.stringify(reply)).toContain("targetBranch must be a nonempty branch name");
  }
});

test("mixed create/update fields are refused before any publication work", async () => {
  for (const action of ["create", "update"]) {
    const fields = action === "create" ? ["pullRequestId", "notify"] : ["sourceBranch", "draft"];
    for (const field of fields) {
      const args = action === "create"
        ? { action, repository: "fixture", sourceBranch: "topic", category: "fix", title: "Fixture",
          problem: "Fixture.", solution: "Fixture.", validation: "Fixture.", uiChange: false, [field]: true }
        : { action, repository: "fixture", pullRequestId: 1, [field]: true };
      const reply = await callTool({ id: 1, params: { name: "bohemia_pr", arguments: args } });
      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0].text).toContain(`${field} is not valid for PR ${action}`);
    }
  }
});

test("failed fresh setup retries its own clean branch after master advances", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, ".git", "fail-gate"), "");
  expect(() => runOperation("prepare", { ...f.input, runSetup: true }, { gateScript: f.gate })).toThrow();
  fs.unlinkSync(path.join(f.root, ".git", "fail-gate"));
  fs.writeFileSync(path.join(f.remote, "later.txt"), "later\n");
  f.git(f.remote, "add", "."); f.git(f.remote, "commit", "-m", "advance");
  const result = runOperation("prepare", { ...f.input, runSetup: true }, { gateScript: f.gate });
  expect(result.commit).toBe(f.git(f.remote, "rev-parse", "HEAD"));
}, 15_000);

test("actual Bohemia setup executes the fixture CI template and the same standalone build", () => {
  expect(process.env.BOHEMIA_GATE_TEST_NAMESPACE).toBe(path.basename(testHome));
  const f = fixture();
  const templates = path.join(f.root, "azure", "build-pipelines", "templates");
  fs.mkdirSync(templates, { recursive: true });
  fs.writeFileSync(path.join(templates, "..", "pr-build.yaml"),
    "jobs:\n  - job: BuildAndUnitTests\n    variables:\n      BuildConfiguration: release\n");
  fs.writeFileSync(path.join(f.root, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({
    name: "bohemia-fixture", packageManager: "pnpm@11.0.0", scripts: { lage: "node fixture-lage.cjs" },
  }));
  fs.writeFileSync(path.join(f.root, "pnpm-lock.yaml"), "fixture-lock\n");
  fs.writeFileSync(path.join(f.root, "fixture-lage.cjs"),
    "require('fs').appendFileSync('.git/actual-builds.jsonl',JSON.stringify(process.argv.slice(2))+'\\n')");
  fs.writeFileSync(path.join(templates, "install-deps.yaml"),
    `steps:\n  - bash: node -e "const fs=require('fs');fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/.modules.yaml','fixture');fs.writeFileSync('.git/ci-installed','yes')"\n    displayName: Fixture CI dependency install\n`);
  f.git(f.root, "add", "."); f.git(f.root, "commit", "-m", "fixture build");
  const result = runOperation("prepare", { repoRoot: f.root, operation: "setup" });
  expect(result.buildWarmed).toBe(true);
  expect(fs.readFileSync(path.join(f.root, ".git", "ci-installed"), "utf8")).toBe("yes");
  expect(fs.existsSync(path.join(f.root, "node_modules", ".ci-install.json"))).toBe(true);
  expect(fs.existsSync(path.join(f.root, ".git", "hooks", "commit-msg"))).toBe(true);
  expect(fs.existsSync(path.join(f.root, ".github", "copilot", "settings.local.json"))).toBe(false);
  fs.unlinkSync(path.join(f.root, ".git", "ci-installed"));
  const reused = runOperation("prepare", { repoRoot: f.root, operation: "setup", runBuild: false });
  expect(reused.ready).toBe(true);
  expect(reused.buildWarmed).toBe(false);
  expect(fs.existsSync(path.join(f.root, ".git", "ci-installed"))).toBe(false);
  runOperation("build", { repoRoot: f.root });
  const builds = fs.readFileSync(path.join(f.root, ".git", "actual-builds.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(builds).toHaveLength(2);
  expect(builds[0]).toEqual(builds[1]);
  expect(builds[0]).toContain("transpile");
  expect(builds[0]).toContain("postTranspile");
  expect(builds[0].slice(-2)).toEqual(["--flavor", "release"]);
  const telemetry = fs.readFileSync(path.join(testHome, ".bohemia-gate", "runs.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  expect(telemetry.filter(record => record.repo === f.root && record.kind === "run.end")).toHaveLength(3);
  expect(telemetry.some(record => record.repo === f.root && record.step === "Check installed dependencies" && !record.failed)).toBe(true);
}, 45_000);

test("explicit conflict resume preserves authored merge resolutions without resetting them", () => {
  const f = fixture();
  f.git(f.remote, "checkout", "-b", "topic");
  fs.writeFileSync(path.join(f.remote, "tracked.txt"), "topic change\n");
  f.git(f.remote, "add", "."); f.git(f.remote, "commit", "-m", "topic");
  f.git(f.remote, "checkout", "master");
  fs.writeFileSync(path.join(f.remote, "tracked.txt"), "master change\n");
  f.git(f.remote, "add", "."); f.git(f.remote, "commit", "-m", "master");
  const input = { ...f.input, mode: "checkout", mergeMaster: true, allowConflicts: true };
  const result = runOperation("prepare", input);
  expect(result.merge.conflicted).toBe(true);
  expect(result.merge.files).toEqual(["tracked.txt"]);
  expect(runOperation("prepare", { ...input, mode: "resume" }).merge.resumed).toBe(true);
  fs.writeFileSync(path.join(f.root, "extra.txt"), "untracked agent work\n");
  expect(() => runOperation("prepare", { ...input, mode: "resume", allowConflicts: false })).toThrow("authored work");
  f.git(f.root, "add", "extra.txt");
  expect(() => runOperation("prepare", { ...input, mode: "resume", allowConflicts: false })).toThrow("authored work");
  f.git(f.root, "reset", "--", "extra.txt");
  fs.unlinkSync(path.join(f.root, "extra.txt"));
  fs.writeFileSync(path.join(f.root, "tracked.txt"), "agent resolution\n");
  expect(() => runOperation("prepare", { ...input, mode: "resume", allowConflicts: false })).toThrow("authored work");
  f.git(f.root, "add", "tracked.txt");
  const staged = f.git(f.root, "diff", "--cached");
  expect(runOperation("prepare", { ...input, mode: "resume" }).merge.resumed).toBe(true);
  expect(f.git(f.root, "diff", "--cached")).toBe(staged);
  expect(fs.readFileSync(path.join(f.root, "tracked.txt"), "utf8")).toBe("agent resolution\n");
}, 30_000);

test("capacity failure happens before branch mutation", () => {
  const f = fixture();
  expect(() => runOperation("prepare", { ...f.input, minimumFreeGiB: 1e12 })).toThrow("GiB");
  expect(f.git(f.root, "branch", "--show-current")).toBe("master");
});

test("provisioning never imports a seed's unpushed work into a task checkout", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, "seed-only.txt"), "seed's private work\n");
  f.git(f.root, "add", "."); f.git(f.root, "commit", "-m", "seed-only work");
  const seedHead = f.git(f.root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(f.root, "untracked-draft.txt"), "uncommitted seed work\n");
  const taskRoot = path.join(f.temp, "task-clone");
  const result = runOperation("prepare", { repoRoot: taskRoot, seedRoot: f.root, operation: "branch",
    branch: "master", mode: "checkout", expectedHead: f.commit, runSetup: false });
  expect(result.commit).toBe(f.commit);
  expect(fs.existsSync(path.join(taskRoot, "seed-only.txt"))).toBe(false);
  expect(fs.statSync(path.join(taskRoot, ".git")).isDirectory()).toBe(true);
  expect(f.git(taskRoot, "config", "maintenance.auto")).toBe("false");
  expect(f.git(taskRoot, "config", "gc.auto")).toBe("0");
  expect(fs.existsSync(path.join(taskRoot, "untracked-draft.txt"))).toBe(false);
  expect(fs.readFileSync(path.join(f.root, "untracked-draft.txt"), "utf8")).toBe("uncommitted seed work\n");
  expect(f.git(f.root, "rev-parse", "HEAD")).toBe(seedHead);
}, 15_000);
