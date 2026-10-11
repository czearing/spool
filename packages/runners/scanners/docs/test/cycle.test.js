import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCycleConfig } from "../config.js";
import { runDocsCycle, runDocsWake, summarise } from "../cycle.js";
import { fixtureRepo, readers, trees } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

function git(cwd, args) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "docs-cycle-"));
  const repo = join(dir, "repo");
  cpSync(fixtureRepo, repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Root\n\nOut of the measured trees.\n", "utf8");
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "engine@example.invalid"]);
  git(repo, ["config", "user.name", "docs engine test"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "first"]);

  const engineConfig = {
    tool: "docs-engine",
    assigneeAgentId: "writer-1",
    defectOwnerAgentId: "owner-1",
    parentIssueId: "parent-1",
    repoRoot: repo,
    trees,
    telemetryPath: join(dir, "docs-cycles.jsonl"),
    watermarkPath: join(dir, "docs-watermark.json"),
    todoPath: join(dir, "docs-todo.md"),
    targetsPath: resolve(here, "..", "targets.json"),
    maxOpenTasks: 1,
    maxFilesPerSet: 4,
    bodyBudget: 1600,
    titleBudget: 120,
    readers,
  };

  const build = (extra = []) =>
    buildCycleConfig({
      argv: ["--dry-run", "--min-overage", "1", ...extra],
      env: {},
      engineConfig,
    });

  return { dir, repo, engineConfig, build };
}

function commitChange(repo, relPath, text) {
  appendFileSync(join(repo, relPath), text, "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", `change ${relPath}`]);
}

test("a dry run against a real repository writes one issue to an in memory queue and no real issue", async () => {
  const h = harness();
  try {
    const config = h.build();
    const summary = await runDocsCycle(config);

    assert.equal(config.queue.created.length, 1, "one run writes at most one issue");
    const issue = config.queue.created[0];
    assert.equal(issue.assigneeAgentId, "writer-1");
    assert.equal(issue.parentId, "parent-1");
    assert.match(issue.description, /document set: /);
    assert.match(issue.description, /reader: /);
    const reproduction = /reproduction: node "([^"]+)" /.exec(issue.description);
    assert.ok(reproduction, "the issue carries a reproduction command with a quoted entry point");
    assert.equal(existsSync(reproduction[1]), true, "the command written into the issue names a file that exists");
    assert.match(issue.description, /acceptance: /);
    assert.match(issue.description, /exclusion: never touch AGENTS.md/);
    assert.equal(issue.description.includes("AGENTS.md,\n"), false);
    assert.ok(issue.description.length <= h.engineConfig.bodyBudget);

    const records = config.telemetry.read();
    assert.equal(records.filter((record) => record.kind === "cycle").length, 1);
    assert.equal(records.filter((record) => record.transition === "opened").length, 1);
    assert.equal(summary.empty, false);

    const view = readFileSync(config.todoPath, "utf8");
    assert.match(view, /open tasks: 1 of 1/);
    assert.equal(existsSync(h.engineConfig.telemetryPath), false, "a dry run leaves the shipped log alone");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a second run with the watermark unchanged appends a record and writes no issue", async () => {
  const h = harness();
  try {
    await runDocsCycle(h.build());
    const config = h.build();
    const summary = await runDocsCycle(config);

    assert.equal(summary.empty, true);
    assert.equal(config.queue.created.length, 0);
    assert.equal(summary.gate.reason, "mark_unchanged");
    const records = config.telemetry.read();
    assert.equal(records.filter((record) => record.kind === "cycle").length, 2);
    assert.equal(records[records.length - 1].gate.proceed, false);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a run with a change in scope is still refused while the cap is full and the watermark holds", async () => {
  const h = harness();
  try {
    const first = h.build();
    await runDocsCycle(first);
    const watermarkAfterFirst = readFileSync(first.context.watermarkPath, "utf8");

    commitChange(h.repo, "apps/new-office/docs/guide.md", "\nA sentence that says nothing much at all here.\n");
    const config = h.build();
    const summary = await runDocsCycle(config);

    assert.equal(summary.empty, true);
    assert.equal(summary.selection.reason, "max_open_tasks_reached");
    assert.equal(config.queue.created.length, 0);
    assert.equal(
      readFileSync(config.context.watermarkPath, "utf8"),
      watermarkAfterFirst,
      "work the cap refused is not marked as observed",
    );
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the entry point prints one json summary and exits zero on an empty cycle", async () => {
  const h = harness();
  try {
    await runDocsCycle(h.build());
    const config = h.build();
    let out = "";
    const code = await runDocsWake(config, { stdout: { write: (text) => (out += text) } });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.empty, true);
    assert.equal(parsed.issueId, null);
    assert.equal(parsed.gate.proceed, false);
    assert.equal(parsed.tool, "docs-engine");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the entry point exits one when the cycle cannot run", async () => {
  const h = harness();
  try {
    const config = h.build();
    config.selector = null;
    let out = "";
    const code = await runDocsWake(config, { stdout: { write: (text) => (out += text) } });
    assert.equal(code, 1);
    assert.match(JSON.parse(out).error, /selector must be a function/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the summary names the set, the files and what the exclusion skipped", async () => {
  const h = harness();
  try {
    const config = h.build();
    const summary = await runDocsCycle(config);
    const printed = summarise(summary, config);
    assert.match(printed.candidateSet, /^new-office-(app|ux):/);
    assert.ok(printed.candidateFiles.length >= 1);
    assert.equal(printed.filesSkippedByExclusion, 2);
    assert.equal(printed.candidateFiles.some((path) => path.includes("AGENTS.md")), false);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
