import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startRunner } from "../src/runner-launcher.js";
import { requestRunnerStop } from "../src/runner-runtime.js";
import { isProcessAlive, readRunnerState, runtimePaths } from "../src/supervisor.js";
import { readRunnerJson, writeRunnerJson } from "../src/runner-files.js";

const runtimeModule = new URL("../src/runner-runtime.js", import.meta.url).href;

async function until(read, predicate, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = read();
    if (predicate(value)) return value;
    await delay(20);
  }
  assert.fail("Timed out waiting for fixture state");
}

function fixture(t, body) {
  const directory = mkdtempSync(path.join(tmpdir(), "runner-lifecycle-"));
  const entry = path.join(directory, "run.mjs");
  const runner = { directory, entry, name: "fixture" };
  const children = [];
  writeFileSync(entry, `
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runManagedRunner } from ${JSON.stringify(runtimeModule)};
await runManagedRunner(import.meta.url, async runner => {
  const deadline = setTimeout(() => runner.stop(), 15000);
  try { ${body} } finally { clearTimeout(deadline); }
});
`);
  const launch = () => {
    const child = spawn(process.execPath, [entry], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.output = "";
    child.stdout.on("data", data => { child.output += data; });
    child.stderr.on("data", data => { child.output += data; });
    children.push(child);
    return child;
  };
  t.after(async () => {
    const state = readRunnerState(runner);
    if (state.running) await requestRunnerStop(entry, state.pid);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    }
    await until(() => readRunnerState(runner), state => !state.running);
    await until(() => isProcessAlive(state.pid), alive => !alive);
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { runner, launch, paths: runtimePaths(runner), state: () => readRunnerState(runner) };
}

test("concurrent direct launches initialize exactly once and losing launch cannot overwrite ownership", async t => {
  const f = fixture(t, `
    appendFileSync(new URL("./initialized.txt", import.meta.url), process.pid + "\\n");
    await runner.poll({ intervalMs: 100, scan: async () => ({ detected: 7 }) });
  `);
  const a = f.launch();
  const b = f.launch();
  const state = await until(f.state, state => state.ready);
  await until(() => [a, b].filter(child => child.exitCode !== null).length, count => count === 1);
  assert.equal(readFileSync(path.join(f.runner.directory, "initialized.txt"), "utf8").trim(), String(state.pid));
  const owner = readRunnerJson(f.paths.pidFile);
  assert.equal(owner.instanceId, f.state().status.instanceId);
  assert.equal(f.state().pid, state.pid);
});

test("fresh PID alone and a prior successful instance cannot satisfy readiness", async t => {
  const f = fixture(t, `
    await runner.poll({ intervalMs: 100, scan: async () => { await delay(350); return { detected: 1 }; } });
  `);
  writeRunnerJson(f.paths.statusFile, {
    pid: process.pid, instanceId: "previous", phase: "ready", lastScan: new Date().toISOString(),
  });
  f.launch();
  await until(f.state, state => state.phase === "scanning");
  assert.equal(f.state().ready, false);
  assert.equal(f.state().lastScan, null);
  await until(f.state, state => state.ready);
});

test("failed scans retain the last successful observations and recovery clears the failure", async t => {
  const f = fixture(t, `
    let cycle = 0;
    await runner.poll({ intervalMs: 200, scan: async () => {
      if (++cycle === 2) throw new Error("queue unavailable");
      return { detected: cycle };
    } });
  `);
  f.launch();
  const good = await until(f.state, state => state.ready);
  const failed = await until(f.state, state => !!state.lastError);
  assert.equal(failed.lastError, "queue unavailable");
  assert.equal(failed.lastScan, good.lastScan);
  assert.equal(failed.status.detected, 1);
  assert.equal(failed.ready, false);
  const recovered = await until(f.state, state => state.ready && state.status.detected >= 3);
  assert.equal(recovered.lastError, null);
});

test("stop waits for the current scan, releases ownership and allows a new instance", async t => {
  const f = fixture(t, `
    await runner.poll({ intervalMs: 10000, scan: async () => {
      await delay(400);
      appendFileSync(new URL("./finished.txt", import.meta.url), "finished\\n");
      return { detected: 1 };
    } });
  `);
  const child = f.launch();
  const scanning = await until(f.state, state => state.phase === "scanning");
  await requestRunnerStop(f.runner.entry, scanning.pid);
  assert.equal(child.exitCode, null);
  await once(child, "exit");
  assert.equal(readFileSync(path.join(f.runner.directory, "finished.txt"), "utf8"), "finished\n");
  assert.equal(f.state().running, false);
  f.launch();
  const replacement = await until(f.state, state => state.ready);
  assert.notEqual(replacement.pid, scanning.pid);
  assert.notEqual(replacement.status.instanceId, scanning.status.instanceId);
});

test("crashed fixture releases the OS lock and stale PID cannot prevent replacement", async t => {
  const f = fixture(t, `
    if (process.env.FIXTURE_CRASH === "yes") process.exit(19);
    await runner.poll({ intervalMs: 100, scan: async () => ({ detected: 1 }) });
  `);
  const crashing = spawn(process.execPath, [f.runner.entry], {
    env: { ...process.env, FIXTURE_CRASH: "yes" }, windowsHide: true, stdio: "ignore",
  });
  assert.equal((await once(crashing, "exit"))[0], 19);
  assert.equal(f.state().running, false);
  f.launch();
  assert.equal((await until(f.state, state => state.ready)).lastError, null);
});

test("launcher waits for a successful scan and concurrent launchers converge on one owner", async t => {
  const f = fixture(t, `
    appendFileSync(new URL("./initialized.txt", import.meta.url), process.pid + "\\n");
    await runner.poll({ intervalMs: 100, scan: async () => { await delay(200); return { detected: 2 }; } });
  `);
  const [a, b] = await Promise.all([
    startRunner(f.runner, { processes: [], timeoutMs: 10_000 }),
    startRunner(f.runner, { processes: [], timeoutMs: 10_000 }),
  ]);
  assert.equal(a.pid, b.pid);
  assert.equal(a.ready, true);
  assert.equal(readFileSync(path.join(f.runner.directory, "initialized.txt"), "utf8").trim(), String(a.pid));
});

test("readiness timeout preserves a slow process; later startup adopts it without duplication", async t => {
  const f = fixture(t, `
    await runner.poll({ intervalMs: 100, scan: async () => { await delay(600); return { detected: 3 }; } });
  `);
  await assert.rejects(startRunner(f.runner, { processes: [], timeoutMs: 150, pollMs: 20 }), /preserving live work/);
  const state = await until(f.state, state => state.ready);
  assert.equal((await startRunner(f.runner)).pid, state.pid);
});

test("initialization and initial scan failures are reported, not successful startup", async t => {
  for (const body of [
    'throw new Error("initialization failed");',
    'await runner.poll({ intervalMs: 1000, scan: async () => { throw new Error("scan failed"); } });',
  ]) {
    const f = fixture(t, body);
    await assert.rejects(startRunner(f.runner, { processes: [], timeoutMs: 5_000, pollMs: 25 }),
      /exited before readiness|degraded/);
    assert.equal(f.state().ready, false);
    assert.match(f.state().lastError, /failed/);
  }
});

test("spawn errors are handled explicitly without a success-shaped PID record", async t => {
  const f = fixture(t, "");
  await assert.rejects(startRunner(f.runner, {
    processes: [],
    spawnImpl: () => spawn(path.join(f.runner.directory, "missing-node.exe"), [], { windowsHide: true }),
  }), /launch failed/);
  assert.equal(readRunnerJson(f.paths.pidFile), null);
});

test("observations expose in-flight work without advancing successful scan timestamps", async t => {
  const f = fixture(t, `
    await runner.poll({ intervalMs: 10000, scan: async () => {
      runner.observe({ preparation: { progressAt: new Date().toISOString() }, open: 9 });
      await delay(400);
      return { detected: 1 };
    } });
  `);
  f.launch();
  const state = await until(f.state, value => !!value.status?.preparation);
  assert.equal(state.lastScan, null);
  assert.equal(state.phase, "scanning");
  assert.equal(state.status.open, 9);
  assert.equal(state.ready, false);
  await until(f.state, value => value.ready);
});
