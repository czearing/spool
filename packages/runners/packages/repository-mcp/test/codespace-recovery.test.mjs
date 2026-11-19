import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { nativeBootTime, preservePrebootLock, withCodespaceWorkspaceLock, recoverNativeCodespaceLocks } from "../src/codespaces/recovery.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "repository-mcp.lock") };
}
test("only a proven dead pre-boot lock is archived with its complete original evidence", t => {
  const f = fixture(t), original = JSON.stringify({ pid: 123, startedAt: "2026-10-22T00:00:00Z" });
  fs.writeFileSync(f.file, original);
  const archive = preservePrebootLock(f.file, {
    bootTime: Date.parse("2026-10-23T00:00:00Z"), alive: pid => { assert.equal(pid, 123); return false; },
  });
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.readFileSync(archive, "utf8"), original);
});
for (const scenario of ["live", "same-boot", "invalid-owner", "unknown-process"]) {
  test(`recovery refuses ${scenario} ownership without modifying the original lock`, t => {
    const f = fixture(t);
    const original = JSON.stringify({ pid: scenario === "invalid-owner" ? -1 : 123,
      startedAt: scenario === "same-boot" ? "2026-10-23T01:00:00Z" : "2026-10-22T00:00:00Z" });
    fs.writeFileSync(f.file, original);
    assert.throws(() => preservePrebootLock(f.file, {
      bootTime: Date.parse("2026-10-23T00:00:00Z"),
      alive: () => { if (scenario === "unknown-process") throw new Error("Unknown process state"); return scenario === "live"; },
    }), /cannot be proven|Unknown process/);
    assert.equal(fs.readFileSync(f.file, "utf8"), original);
  });
}
test("changed evidence and an existing archive are never replaced", t => {
  const f = fixture(t), original = JSON.stringify({ pid: 123, at: "2026-10-22T00:00:00Z" });
  fs.writeFileSync(f.file, original);
  assert.throws(() => preservePrebootLock(f.file, {
    bootTime: Date.parse("2026-10-23T00:00:00Z"),
    alive: () => { fs.writeFileSync(f.file, "new live owner"); return false; },
  }), /changed during recovery/);
  assert.equal(fs.readFileSync(f.file, "utf8"), "new live owner");
  fs.writeFileSync(f.file, original);
  const options = { bootTime: Date.parse("2026-10-23T00:00:00Z"), alive: () => false };
  const archive = preservePrebootLock(f.file, options);
  fs.writeFileSync(f.file, original);
  assert.throws(() => preservePrebootLock(f.file, options), /archive already exists/);
  assert.equal(fs.readFileSync(archive, "utf8"), original);
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
});
test("container restart recovers only locks older than its namespace, not just its host VM", t => {
  const f = fixture(t), now = Date.now(), at = new Date(now - 60000).toISOString();
  fs.mkdirSync(path.join(f.root, "1"));
  const fields = Array(20).fill("0");
  fields[0] = "S"; fields[2] = "1"; fields[19] = "9000";
  fs.writeFileSync(path.join(f.root, "1", "stat"), `1 (container init) ${fields.join(" ")}`);
  const original = JSON.stringify({ pid: 123, action: "prepare", at });
  fs.writeFileSync(f.file, original);
  const options = { bootTime: now - 120000, alive: () => false };
  assert.throws(() => preservePrebootLock(f.file, { ...options, assertIdle() {
    assert.fail("Unknown same-namespace ownership must not enter recovery");
  } }), /cannot be proven/);
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
  const bootTime = nativeBootTime({ procRoot: f.root, bootTime: options.bootTime, clockTicks: 100 });
  const archive = preservePrebootLock(f.file, { ...options, bootTime, assertIdle() {
    assert.fail("A dead owner from the previous container cannot have surviving children in this namespace");
  } });
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.readFileSync(archive, "utf8"), original);
  const current = JSON.stringify({ pid: 123, action: "prepare", at: new Date(now - 1000).toISOString() });
  fs.writeFileSync(f.file, current);
  assert.throws(() => preservePrebootLock(f.file, { ...options, bootTime }), /cannot be proven/);
  assert.equal(fs.readFileSync(f.file, "utf8"), current);
});
test("container boot recovery refuses malformed, zombie or future namespace identities", t => {
  const f = fixture(t), file = path.join(f.root, "1", "stat");
  fs.mkdirSync(path.dirname(file));
  for (const [state, parent, started] of [["S", "12", "1"], ["Z", "0", "1"],
    ["S", "0", "-1"], ["S", "0", "1000000"]]) {
    const fields = Array(20).fill("0");
    fields[0] = state; fields[1] = parent; fields[2] = "1"; fields[19] = started;
    fs.writeFileSync(file, `1 (container init) ${fields.join(" ")}`);
    assert.throws(() => nativeBootTime({ procRoot: f.root, bootTime: Date.now() - 120000, clockTicks: 100 }),
      /Cannot verify native process/);
  }
});
test("an active Codespace operation keeps its lock and cannot be replaced by recovery", async t => {
  const f = fixture(t);
  let release;
  const running = withCodespaceWorkspaceLock(f.root, () => new Promise(resolve => { release = resolve; }));
  const owner = fs.readFileSync(f.file, "utf8");
  assert.throws(() => withCodespaceWorkspaceLock(f.root, () => assert.fail("Must not execute")), error => {
    assert.equal(error.code, "CODESPACE_WORKSPACE_BUSY");
    assert.equal(error.reasonCode, "workspace_busy");
    return true;
  });
  assert.equal(fs.readFileSync(f.file, "utf8"), owner);
  release();
  await running;
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(`${f.file}.recovery`), false);
});
test("a real exited pre-boot owner is recovered and the next operation owns the replacement lock", async t => {
  const f = fixture(t);
  const pid = Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim());
  const original = JSON.stringify({ pid, startedAt: "2000-01-01T00:00:00Z" });
  fs.writeFileSync(f.file, original);
  const result = await withCodespaceWorkspaceLock(f.root, async () => {
    assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).pid, process.pid);
    assert.equal(fs.existsSync(`${f.file}.recovery`), true);
    await Promise.resolve();
    assert.equal(fs.existsSync(`${f.file}.recovery`), false);
    return "verified";
  });
  assert.equal(result, "verified");
  assert.equal(fs.existsSync(f.file), false);
  const archives = fs.readdirSync(f.root).filter(name => name.startsWith("repository-mcp.lock.stale-"));
  assert.equal(archives.length, 1);
  assert.equal(fs.readFileSync(path.join(f.root, archives[0]), "utf8"), original);
});
test("native recovery refuses arbitrary paths or absent lifecycle ownership", () => {
  assert.throws(() => recoverNativeCodespaceLocks("/other", "/workspaces", "/workspaces/.spool-engineer-tools", "a".repeat(36)),
    /registered native paths/);
  assert.throws(() => recoverNativeCodespaceLocks("/workspaces/1JS", "/workspaces", "/workspaces/.spool-engineer-tools", ""),
    /owned lifecycle/);
});
