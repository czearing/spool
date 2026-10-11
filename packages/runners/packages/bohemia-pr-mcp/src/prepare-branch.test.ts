import "./test-environment.ts";
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOperation } from "./operations.mjs";
import { refreshUnchanged } from "./prepare-branch.mjs";

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia-line-endings-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  git("init", "-b", "master");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "true");
  git("config", "core.safecrlf", "false");
  fs.writeFileSync(path.join(root, "generated.ts"), "export const value = 1;\r\n");
  git("add", ".");
  git("commit", "-m", "initial");
  git("remote", "add", "origin", root);
  const command = (_exe: string, args: string[]) => {
    const stdout = git(...args);
    return { code: 0, stdout, output: stdout };
  };
  return { root, git, command, file: path.join(root, "generated.ts") };
}

test("canonical-only generated dirt is refreshed without changing source bytes or staging a diff", () => {
  const f = fixture();
  fs.writeFileSync(f.file, "export const value = 1;\n");
  expect(f.git("status", "--porcelain")).toContain(" M generated.ts");
  const before = fs.readFileSync(f.file);
  const tree = f.git("write-tree");
  refreshUnchanged(f.command);
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.git("write-tree")).toBe(tree);
  expect(fs.readFileSync(f.file)).toEqual(before);
});

test("checking out the target branch fetches it only once without skipping the target refresh", () => {
  const f = fixture();
  const trace = path.join(f.root, ".git", "trace.jsonl");
  const result = runOperation("prepare", {
    repoRoot: f.root, operation: "branch", mode: "checkout", branch: "master", baseBranch: "master", runSetup: false,
  }, { environment: { ...process.env, GIT_TRACE2_EVENT: trace } });
  expect(result.ready).toBe(true);
  const fetches = fs.readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line))
    .filter(event => event.event === "start" && event.argv?.[1] === "fetch");
  expect(fetches).toHaveLength(1);
  expect(fetches[0].argv).toContain("+refs/heads/master:refs/remotes/origin/master");
  expect(f.git("rev-parse", "origin/master").trim()).toBe(result.commit);
}, 30000);

test("real edits, whitespace changes, staged edits and untracked files remain untouched", () => {
  const f = fixture();
  for (const content of ["export const value = 2;\n", "export  const value = 1;\n"]) {
    fs.writeFileSync(f.file, content);
    refreshUnchanged(f.command);
    expect(f.git("status", "--porcelain")).toContain(" M generated.ts");
    expect(f.git("diff", "--cached")).toBe("");
    expect(fs.readFileSync(f.file, "utf8")).toBe(content);
  }
  f.git("add", "generated.ts");
  fs.writeFileSync(path.join(f.root, "new.ts"), "authored\n");
  const staged = f.git("diff", "--cached");
  refreshUnchanged(f.command);
  expect(f.git("diff", "--cached")).toBe(staged);
  expect(f.git("status", "--porcelain")).toContain("?? new.ts");
});

test("exact-revision preparation accepts canonical-only dirt but rejects authored changes", () => {
  const f = fixture();
  const sourceCommit = f.git("rev-parse", "HEAD").trim();
  const input = { repoRoot: f.root, operation: "branch", mode: "checkout",
    branch: "review/fixture", sourceCommit, reset: false, mergeMaster: false, runSetup: false };
  fs.writeFileSync(f.file, "export const value = 1;\n");
  expect(runOperation("prepare", input)).toMatchObject({ ready: true, commit: sourceCommit });
  fs.writeFileSync(f.file, "export const value = 2;\n");
  expect(() => runOperation("prepare", input)).toThrow("Checkout is dirty");
  expect(fs.readFileSync(f.file, "utf8")).toBe("export const value = 2;\n");
  expect(f.git("diff", "--cached")).toBe("");
});

test("literal filenames cannot stage a different path containing authored work", () => {
  const f = fixture();
  f.git("mv", "generated.ts", "generated[1].ts");
  fs.writeFileSync(path.join(f.root, "generated1.ts"), "original\r\n");
  f.git("add", ".");
  f.git("commit", "-m", "literal paths");
  fs.writeFileSync(path.join(f.root, "generated[1].ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(f.root, "generated1.ts"), "authored\r\n");
  refreshUnchanged(f.command);
  expect(f.git("status", "--porcelain")).toBe(" M generated1.ts\n");
  expect(f.git("diff", "--cached")).toBe("");
});

test("setup that only rewrites line endings still produces a clean handoff", () => {
  const f = fixture();
  const gate = path.join(f.root, ".git", "fixture-gate.ps1");
  fs.writeFileSync(gate, 'param($Action,$RepoRoot,[switch]$SkipWarmBuild)\n' +
    '[IO.File]::WriteAllText((Join-Path $RepoRoot "generated.ts"), "export const value = 1;`n")\n');
  expect(runOperation("prepare", { repoRoot: f.root, operation: "branch", mode: "create",
    branch: "topic", runSetup: true, runBuild: false }, { gateScript: gate })).toMatchObject({ ready: true });
  expect(f.git("status", "--porcelain")).toBe("");
}, 30_000);
