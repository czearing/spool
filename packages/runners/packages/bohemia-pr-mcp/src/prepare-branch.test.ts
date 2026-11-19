import "./test-environment.ts";
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOperation } from "./operations.mjs";
import { refreshUnchanged, discardPreparationChanges } from "./prepare-branch.mjs";

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

test("a newly prepared merge records its exact target commit for the receiving original agent", () => {
  const f = fixture();
  f.git("checkout", "-b", "user/source");
  fs.writeFileSync(f.file, "export const value = 2;\r\n");
  f.git("add", "."); f.git("commit", "-m", "Source revision");
  const source = f.git("rev-parse", "HEAD").trim();
  f.git("checkout", "master");
  fs.writeFileSync(path.join(f.root, "target.txt"), "Target addition\n");
  f.git("add", "."); f.git("commit", "-m", "Target revision");
  const target = f.git("rev-parse", "HEAD").trim();
  f.git("checkout", "user/source");
  const result = runOperation("prepare", { repoRoot: f.root, operation: "branch", mode: "resume",
    branch: "user/source", expectedHead: source, mergeMaster: true, runSetup: false });
  expect(result.ready).toBe(true);
  expect(result.merge.targetCommit).toBe(target);
  expect(result.merge.conflicted).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(f.root, ".git", "bohemia-preparation.json"), "utf8"))
    .merge.targetCommit).toBe(target);
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

test("exact-revision preparation refreshes canonical dirt and discards real changes", () => {
  const f = fixture();
  const sourceCommit = f.git("rev-parse", "HEAD").trim();
  const input = { repoRoot: f.root, operation: "branch", mode: "checkout",
    branch: "review/fixture", sourceCommit, reset: false, mergeMaster: false, runSetup: false };
  fs.writeFileSync(f.file, "export const value = 1;\n");
  expect(runOperation("prepare", input)).toMatchObject({ ready: true, commit: sourceCommit });
  fs.writeFileSync(f.file, "export const value = 2;\n");
  expect(runOperation("prepare", input)).toMatchObject({ ready: true, commit: sourceCommit });
  expect(fs.readFileSync(f.file, "utf8").replace(/\r\n/g, "\n")).toBe("export const value = 1;\n");
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

test("setup-generated tracked changes are discarded and untracked dependencies are locally ignored", () => {
  const f = fixture();
  const generated = path.join(f.root, "midgard", "packages", "custom-bash-v3-ado-extension");
  const result = runOperation("prepare", { repoRoot: f.root, operation: "branch", mode: "create",
    branch: "topic", runSetup: true, runBuild: false }, { runGate() {
    fs.writeFileSync(f.file, "setup rewrote tracked source\n");
    fs.mkdirSync(path.join(generated, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(generated, ".gitignore"), "node_modules/\n");
    fs.writeFileSync(path.join(generated, "node_modules", "dependency.js"), "retained dependency\n");
    fs.writeFileSync(path.join(generated, "generated.js"), "generated output\n");
  } });
  expect(result.ready).toBe(true);
  expect(f.git("status", "--porcelain")).toBe("");
  expect(fs.readFileSync(f.file, "utf8").replace(/\r\n/g, "\n")).toBe("export const value = 1;\n");
  expect(fs.readFileSync(path.join(generated, "node_modules", "dependency.js"), "utf8")).toBe("retained dependency\n");
  expect(fs.existsSync(path.join(generated, "generated.js"))).toBe(true);
  expect(f.git("check-ignore", "midgard/packages/custom-bash-v3-ado-extension/generated.js").trim())
    .toBe("midgard/packages/custom-bash-v3-ado-extension/generated.js");
  expect(JSON.parse(fs.readFileSync(path.join(f.root, ".git", "bohemia-preparation.json"), "utf8")).state)
    .toBe("completed");
  fs.writeFileSync(path.join(generated, "authored.ts"), "new work\n");
  expect(f.git("status", "--porcelain", "--untracked-files=all"))
    .toContain("custom-bash-v3-ado-extension/authored.ts");
});

test("automatic cleanup retains and ignores untracked directories containing ignored dependencies", () => {
  const f = fixture();
  const generated = path.join(f.root, "cache[1]");
  for (const directory of [generated]) {
    fs.mkdirSync(path.join(directory, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(directory, ".gitignore"), "node_modules/\n");
    fs.writeFileSync(path.join(directory, "node_modules", "dependency.js"), "retained\n");
  }
  expect(runOperation("prepare", { repoRoot: f.root, operation: "branch", mode: "create",
    branch: "topic", runSetup: false }).ready).toBe(true);
  expect(f.git("status", "--porcelain")).toBe("");
  expect(fs.readFileSync(path.join(generated, "node_modules", "dependency.js"), "utf8")).toBe("retained\n");
  fs.mkdirSync(path.join(f.root, "cache1"));
  fs.writeFileSync(path.join(f.root, "cache1", "authored.txt"), "visible\n");
  expect(f.git("status", "--porcelain")).toContain("?? cache1/");
});

test("untracked files that cannot be deleted are ignored instead of blocking preparation", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, "locked-output.txt"), "retained\n");
  discardPreparationChanges({
    git: f.git,
    gitPath: name => path.resolve(f.root, f.git("rev-parse", "--git-path", name).trim()),
    command(exe, args, cwd, allowFailure) {
      if (args[0] === "clean") {
        expect(allowFailure).toBe(true);
        return { code: 1, output: "warning: failed to remove locked-output.txt: Permission denied" };
      }
      return f.command(exe, args);
    },
  });
  expect(fs.readFileSync(path.join(f.root, "locked-output.txt"), "utf8")).toBe("retained\n");
  expect(f.git("status", "--porcelain")).toBe("");
});
