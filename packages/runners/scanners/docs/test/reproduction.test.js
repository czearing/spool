/**
 * The reproduction command surface. The command written into an issue is run by an agent standing in
 * the measured clone, not in the engine directory, so a test that only matched the shape of the string
 * proved nothing. Every test here proves the emitted command resolves on disk and runs somewhere else.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { MEASURE_ENTRY_POINT, reproductionCommand } from "../metrics.js";
import { fixtureRepo } from "./helpers.js";

/** Split the emitted command into its entry point and the paths it was given. */
function parseCommand(command) {
  const match = /^node "([^"]+)"(.*)$/.exec(command);
  assert.ok(match, `the emitted command names a quoted entry point: ${command}`);
  return {
    runner: "node",
    entryPoint: match[1],
    args: match[2].trim().split(" ").filter(Boolean),
  };
}

/** The check itself: the command must name a file that is on disk. */
function assertCommandResolves(command) {
  const parsed = parseCommand(command);
  assert.equal(isAbsolute(parsed.entryPoint), true, "the entry point is absolute, not relative to any caller");
  assert.equal(existsSync(parsed.entryPoint), true, `the emitted command names a file that does not exist: ${parsed.entryPoint}`);
  return parsed;
}

test("the file named by the emitted command exists on disk", () => {
  assertCommandResolves(reproductionCommand(["apps/new-office/docs/guide.md"]));
});

test("the check fails when the command names a file that is not there", () => {
  assert.throws(() => assertCommandResolves(`node "${resolve(MEASURE_ENTRY_POINT, "..", "gone.js")}" a.md`));
  assert.throws(() => assertCommandResolves("node measure.js a.md"), "a bare relative entry point is rejected");
});

test("the entry point is derived from the module location rather than written out by hand", () => {
  assert.equal(parseCommand(reproductionCommand(["a.md"])).entryPoint, MEASURE_ENTRY_POINT);
  assert.equal(existsSync(MEASURE_ENTRY_POINT), true);
});

test("the entry point is quoted so a path holding a space survives", () => {
  const command = reproductionCommand(["a.md"]);
  assert.match(command, /^node "/);
  assert.match(command, /measure\.js" a\.md$/);
});

test("the command carries every path of the set, unquoted and repository relative", () => {
  const paths = ["packages/new-office-ux/src/panel.ts", "packages/new-office-ux/docs/component.md"];
  assert.deepEqual(parseCommand(reproductionCommand(paths)).args, paths);
});

test("the emitted command returns numbers when it is run from a directory that is not the engine", () => {
  const parsed = assertCommandResolves(reproductionCommand(["apps/new-office/docs/guide.md"]));
  const stdout = execFileSync(process.execPath, [parsed.entryPoint, ...parsed.args], {
    cwd: tmpdir(),
    env: { ...process.env, DOCS_REPO_ROOT: fixtureRepo },
    encoding: "utf8",
  });

  const result = JSON.parse(stdout);
  assert.equal(result.error, undefined, "the command resolved and measured rather than reporting usage");
  assert.equal(result.repoRoot, fixtureRepo, "the repository root comes from configuration, not from the working directory");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].path, "apps/new-office/docs/guide.md");
  assert.ok(result.rows[0].metrics.length > 0, "the run produced measured numbers");
  assert.equal(typeof result.totalOverage, "number");
});
