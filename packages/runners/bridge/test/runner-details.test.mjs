import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readJson, writeJson } from "../spool-store.mjs";
import { runnerDetails, runnerErrorSummary, trackRepositoryRefresh } from "../runner-details.mjs";
import { fixture } from "./fixtures.mjs";

function setup(t) {
  const f = fixture(t), runtime = path.join(f.root, ".runner");
  const lifecycle = { status: { instanceId: "fixture" } };
  const args = { operation: "branch", repoRoot: f.workspace, branch: "fixture" };
  const row = { runner: "pr-reviewer", pid: process.pid, instanceId: "fixture", connected: true, pollSeconds: 60 };
  const read = () => runnerDetails(row, {}, runtime);
  const run = (action, input = args, name = "bohemia_prepare") => trackRepositoryRefresh(runtime, lifecycle, name, input, action);
  return { ...f, runtime, lifecycle, args, row, read, run };
}

test("script/cadence come from runner definitions and config, never private status commands", t => {
  const f = setup(t);
  const details = runnerDetails({ ...f.row, script: "PRIVATE_COMMAND", lastError: "PRIVATE_TOKEN" }, { scan_interval_seconds: 300 }, f.runtime);
  assert.equal(details.script, "runners\\pr-reviewer\\run.mjs");
  assert.equal(details.intervalSeconds, 300);
  assert.equal(details.activeIntervalSeconds, 60);
  assert.equal(details.repository.mode, "on-demand");
  assert.equal(details.repository.lastUpdatedAt, null);
  assert.equal(details.repository.state, "unknown");
  assert.doesNotMatch(JSON.stringify(details), /PRIVATE/);
  assert.throws(() => runnerDetails(f.row, { scan_interval_seconds: 0 }, f.runtime), /interval/);
});
test("custom repository refreshes report workflow scheduling without leaking node configuration", t => {
  const f = setup(t), setting = { intervalSeconds: 60,
    nodes: [{ kind: "repository", operation: "refresh", command: "PRIVATE", prompt: "PRIVATE" }] };
  const details = runnerDetails({ ...f.row, runner: "custom-check" }, setting, f.runtime);
  assert.equal(details.repository.mode, "workflow");
  assert.doesNotMatch(JSON.stringify(details), /PRIVATE/);
});

test("confirmed preparation records a durable update; a failed retry preserves that timestamp", async t => {
  const f = setup(t);
  await f.run(async () => {
    assert.equal(f.read().repository.state, "updating");
    assert.equal(f.read().repository.lastUpdatedAt, null);
    return f.preparation;
  });
  const successful = f.read().repository;
  assert.equal(successful.state, "succeeded");
  assert.ok(successful.lastUpdatedAt);
  await assert.rejects(f.run(async () => { throw new Error("ERR_PNPM_INSTALL PRIVATE_TOKEN PRIVATE_COMMAND"); }), /PRIVATE_TOKEN/);
  const failed = f.read().repository;
  assert.equal(failed.state, "failed");
  assert.equal(failed.lastUpdatedAt, successful.lastUpdatedAt);
  assert.match(failed.error, /Dependency installation/);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/);
  assert.equal(runnerDetails({ ...f.row, instanceId: "restarted" }, {}, f.runtime).repository.lastUpdatedAt, successful.lastUpdatedAt);
});

test("refresh with an unconfirmed instance is interrupted, never reported as still updating", async t => {
  const f = setup(t);
  await f.run(async () => {
    for (const patch of [{ connected: false }, { instanceId: "different" }, { pid: process.pid + 1 }]) {
      const repository = runnerDetails({ ...f.row, ...patch }, {}, f.runtime).repository;
      assert.equal(repository.state, "interrupted");
      assert.equal(repository.lastUpdatedAt, null);
      assert.match(repository.error, /interrupted/);
    }
    return f.preparation;
  });
});

test("setup and builds cannot claim a repository refresh", async t => {
  const f = setup(t);
  for (const [name, operation] of [["bohemia_prepare", "setup"], ["bohemia_build", undefined]]) {
    await f.run(async () => f.preparation, { ...f.args, operation }, name);
    assert.equal(f.read().repository.state, "unknown");
  }
});

for (const patch of [{ ready: false }, { commit: "invalid" }, { repoRoot: "wrong" }, { branch: "" }]) {
  test(`invalid preparation cannot advance repository freshness: ${JSON.stringify(patch)}`, async t => {
    const f = setup(t);
    await assert.rejects(f.run(async () => ({ ...f.preparation, ...patch })), /did not confirm/);
    assert.equal(f.read().repository.lastUpdatedAt, null);
    assert.equal(f.read().repository.state, "failed");
  });
}

test("malformed refresh records fail explicitly rather than inventing empty success", async t => {
  const f = setup(t);
  await f.run(async () => f.preparation);
  const file = path.join(f.runtime, "repository-refresh.json");
  const valid = readJson(file);
  for (const patch of [{ lastUpdatedAt: "invalid" }, { lastUpdatedAt: null }, { state: "invented" }, { error: "PRIVATE" }]) {
    writeJson(file, { ...valid, ...patch });
    assert.throws(f.read, /Invalid repository refresh record/);
  }
});

test("error summaries never return raw messages or embedded credentials", () => {
  for (const value of ["git dirty PRIVATE", "ETIMEDOUT PRIVATE", "AADSTS PRIVATE", "dependency install PRIVATE", "build failed PRIVATE", "unexpected PRIVATE"]) {
    assert.ok(runnerErrorSummary(value));
    assert.doesNotMatch(runnerErrorSummary(value), /PRIVATE/);
  }
  assert.equal(runnerErrorSummary(null), null);
});
