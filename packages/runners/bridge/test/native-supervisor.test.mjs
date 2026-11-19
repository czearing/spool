import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { nativeSupervisor, runnerEngine } from "../native-supervisor.mjs";

async function until(check) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Rust runner engine did not reach the expected state.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "spool-native-supervisor-"));
  const entry = path.join(root, "worker.mjs"), output = path.join(root, "events.txt");
  writeFileSync(entry, `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const append = text => appendFileSync(process.env.OUTPUT, process.env.VERSION + "-" + text + "\\n");
if (process.env.CRASH && !existsSync(process.env.CRASH)) {
  writeFileSync(process.env.CRASH, "crashed"); process.exit(7);
}
append("start");
console.log("worker stdout");
console.error("worker stderr");
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  if (line === "run") append("wake");
  if (line === "stop") {
    lines.close();
    setTimeout(() => { append("end"); process.stdin.pause(); }, 200);
  }
});
`);
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const engine = nativeSupervisor({ onError: error => errors.push(error) });
  t.after(async () => { await engine.stop(); rmSync(root, { recursive: true, force: true }); });
  await engine.ready;
  const worker = (key = "one", extra = {}) => ({ id: "fixture", key, executable: process.execPath,
    entry, cwd: root, env: { OUTPUT: output, VERSION: key, ...extra }, wake: [] });
  const events = () => existsSync(output) ? readFileSync(output, "utf8") : "";
  return { root, engine, worker, events, errors };
}

test("Rust owns replacement, drains the old worker, and does not restart an unchanged plan", async t => {
  const { engine, worker, events } = await fixture(t);
  await engine.reconcile([worker()]);
  await until(() => events().includes("one-start"));
  const pid = engine.running.get("fixture").child.pid;
  await engine.reconcile([worker()]);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(engine.running.get("fixture").child.pid, pid);
  await engine.reconcile([worker("two")]);
  await until(() => events().includes("two-start"));
  assert.match(events(), /one-start\s+one-end\s+two-start/);
  assert.notEqual(engine.running.get("fixture").child.pid, pid);
  await Promise.all([engine.stop(), engine.stop()]);
  assert.match(events(), /two-end/);
});

test("Rust rejects invalid and duplicate plans without replacing a healthy worker", async t => {
  const { engine, worker, events } = await fixture(t);
  await engine.reconcile([worker()]);
  await until(() => events().includes("one-start"));
  const pid = engine.running.get("fixture").child.pid;
  await assert.rejects(engine.reconcile([{ ...worker("two"), entry: "relative.mjs" }]), /must be absolute/);
  await assert.rejects(engine.reconcile([worker("two"), worker("three")]), /Duplicate runner/);
  assert.equal(engine.running.get("fixture").child.pid, pid);
  assert.equal(events(), "one-start\n");
});

test("Rust deduplicates event wakes and drains removed workers", async t => {
  const { engine, worker, events } = await fixture(t);
  await engine.reconcile([worker()]);
  await until(() => events().includes("one-start"));
  await engine.reconcile([{ ...worker(), wake: ["event-one"] }]);
  await until(() => events().includes("one-wake"));
  await engine.reconcile([{ ...worker(), wake: ["event-one"] }]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(events().match(/one-wake/g).length, 1);
  await engine.reconcile([{ ...worker(), wake: ["event-one", "event-two"] }]);
  await until(() => events().match(/one-wake/g).length === 2);
  await engine.reconcile([]);
  await until(() => engine.running.size === 0);
  assert.match(events(), /one-end/);
});

test("Rust reports a crashed worker and retries it without replaying its owner", async t => {
  const { root, engine, worker, events, errors } = await fixture(t);
  await engine.reconcile([worker("retry", { CRASH: path.join(root, "crashed.txt") })]);
  await until(() => errors.some(error => error?.message?.includes("retrying in 5 seconds")));
  assert.equal(engine.running.size, 0);
  await until(() => events().includes("retry-start"));
  assert.equal(engine.running.size, 1);
  assert.equal(errors.at(-1), null, "successful retry must restore healthy service status");
});

test("Rust persists each worker's terminal output without mixing supervisor protocol into its logs", async t => {
  const { root, engine, worker, events } = await fixture(t);
  await engine.reconcile([worker()]);
  await until(() => events().includes("one-start") &&
    existsSync(path.join(root, ".runner", "runner.log")) &&
    readFileSync(path.join(root, ".runner", "runner.log"), "utf8").includes("worker stdout"));
  const stderr = path.join(root, ".runner", "runner-error.log");
  await until(() => existsSync(stderr) && readFileSync(stderr, "utf8").includes("worker stderr"));
  assert.equal(readFileSync(path.join(root, ".runner", "runner.log"), "utf8").trim(), "worker stdout");
  assert.equal(readFileSync(stderr, "utf8").trim(), "worker stderr");
  assert.equal(engine.running.size, 1);
});

test("Rust accepts runtime executables on PATH and preserves launch failures until recovery", async t => {
  const { root, engine, worker, events, errors } = await fixture(t);
  await engine.reconcile([{ ...worker(), executable: path.join(root, "missing-runtime.exe") }]);
  assert.ok(errors.some(error => error?.message?.includes("Launch failed")));
  await engine.reconcile([{ ...worker(), executable: path.join(root, "missing-runtime.exe") }]);
  assert.notEqual(errors.at(-1), null, "reloading the same failed plan must not report healthy status");
  await engine.reconcile([]);
  await engine.reconcile([{ ...worker(), executable: "node" }]);
  await until(() => events().includes("one-start"));
  assert.equal(errors.at(-1), null);
});

test("Rust drains workers when its parent closes the control pipe without a stop command", async t => {
  const { worker, events } = await fixture(t);
  const core = spawn(runnerEngine(), ["runner-supervisor"], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(core, "close");
  let output = "", errors = "";
  core.stdout.on("data", data => { output += data; });
  core.stderr.on("data", data => { errors += data; });
  core.stdin.end(JSON.stringify({ type: "reconcile", request: 1, workers: [worker()] }) + "\n");
  const [code] = await exited;
  assert.equal(code, 0, errors);
  assert.match(events(), /one-start\s+one-end/);
  assert.equal(JSON.parse(output.trim().split("\n").at(-1)).type, "stopped");
});
