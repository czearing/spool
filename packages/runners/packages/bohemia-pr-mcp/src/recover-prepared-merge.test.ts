import "./test-environment.ts";
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOperation } from "./operations.mjs";
import { executePreparation } from "./preparation-process.mjs";

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia-prepared-merge-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const file = path.join(root, "conflict.txt");
  git("init", "-b", "master"); git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid"); git("config", "core.autocrlf", "false");
  fs.writeFileSync(file, "base\n"); fs.writeFileSync(path.join(root, "stable.txt"), "stable\n");
  git("add", "."); git("commit", "-m", "base");
  git("checkout", "-b", "repair"); fs.writeFileSync(file, "repair\n");
  git("commit", "-am", "repair");
  const head = git("rev-parse", "HEAD");
  git("checkout", "master"); fs.writeFileSync(file, "upstream\n"); git("commit", "-am", "upstream");
  git("checkout", "repair"); git("remote", "add", "origin", root);
  const input = { repoRoot: root, operation: "branch", branch: "repair", mode: "checkout",
    mergeMaster: true, allowConflicts: true, runSetup: false, runBuild: false, reset: false };
  const prepared = runOperation("prepare", input);
  expect(prepared.merge.conflicted).toBe(true);
  const next = { ...input, branch: "new-incident", mode: "create", mergeMaster: false, allowConflicts: false };
  const snapshot = () => ({ contents: fs.readFileSync(file, "utf8"), staged: git("ls-files", "--stage"),
    branch: git("branch", "--show-current"), head: git("rev-parse", "HEAD"), merge: git("rev-parse", "MERGE_HEAD") });
  return { root, git, file, input, next, head, snapshot };
}

test("a different incident recovers only an untouched canonical merge and preserves its complete evidence", () => {
  const f = fixture(), original = f.snapshot(), tree = f.git("rev-parse", "AUTO_MERGE");
  const result = runOperation("prepare", f.next);
  expect(result.ready).toBe(true);
  expect(result.steps.some((step: { name: string }) => step.name === "recover-prepared-merge")).toBe(true);
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.git("rev-parse", "repair")).toBe(f.head);
  const directory = path.join(f.root, ".git", "bohemia-prepared-merges");
  const files = fs.readdirSync(directory);
  expect(files.length).toBe(1);
  const record = JSON.parse(fs.readFileSync(path.join(directory, files[0]), "utf8"));
  expect(record).toMatchObject({ branch: "repair", head: f.head, tree, target: original.merge });
  expect(Buffer.from(record.index, "base64").length).toBeGreaterThan(0);
  expect(record.mergeMessage).toContain("master");
  const refs = f.git("for-each-ref", "--format=%(objectname)", "refs/bohemia/prepared-merges").split("\n");
  expect(refs.sort()).toEqual([f.head, original.merge, tree].sort());
  expect(f.git("show", `${tree}:conflict.txt`)).toBe(original.contents.trim());
});

for (const edit of ["unstaged resolution", "staged resolution", "untracked file", "staged other file", "missing receipt", "autostash"]) {
  test(`recovery preserves ${edit} and refuses a new handoff`, () => {
    const f = fixture();
    if (edit.includes("resolution")) {
      fs.writeFileSync(f.file, "authored resolution\n");
      if (edit === "staged resolution") f.git("add", "conflict.txt");
    }
    if (edit === "untracked file") fs.writeFileSync(path.join(f.root, "authored.txt"), "untracked\n");
    if (edit === "staged other file") {
      fs.writeFileSync(path.join(f.root, "stable.txt"), "authored\n"); f.git("add", "stable.txt");
    }
    if (edit === "missing receipt") fs.unlinkSync(path.join(f.root, ".git", "bohemia-preparation.json"));
    if (edit === "autostash") fs.writeFileSync(path.join(f.root, ".git", "MERGE_AUTOSTASH"), f.head);
    const before = f.snapshot();
    expect(() => runOperation("prepare", f.next)).toThrow("checkout preserved");
    expect(f.snapshot()).toEqual(before);
    expect(f.git("for-each-ref", "refs/bohemia/prepared-merges")).toBe("");
  });
}

test("same-branch repair resumes its conflicts rather than recovering them away", () => {
  const f = fixture(), before = f.snapshot();
  const result = runOperation("prepare", { ...f.input, mode: "resume" });
  expect(result.merge.resumed).toBe(true);
  expect(f.snapshot()).toEqual(before);
  expect(f.git("for-each-ref", "refs/bohemia/prepared-merges")).toBe("");
});

test("an interrupted recovery retries from its preserved receipt without losing original work", () => {
  const f = fixture(), before = f.snapshot();
  expect(() => runOperation("prepare", f.next, {
    execute(exe: string, args: string[], cwd: string, timeout: number) {
      if (exe === "git" && args[0] === "update-ref") return { code: 1, output: "Injected reference failure" };
      return executePreparation(exe, args, cwd, process.env, timeout);
    },
  })).toThrow();
  expect(f.snapshot()).toEqual(before);
  expect(runOperation("prepare", f.next).ready).toBe(true);
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.git("rev-parse", "repair")).toBe(before.head);
});
