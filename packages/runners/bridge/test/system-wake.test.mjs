import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { preventIdleSleep } from "../system-wake.mjs";

test("native runner wake requests prevent idle system sleep without changing power settings or keeping displays on", async () => {
  const child = new EventEmitter(), calls = [];
  child.stdout = new EventEmitter();
  child.stderr = { resume() {} };
  child.stdin = new EventEmitter();
  child.stdin.end = () => calls.push("released");
  const start = (command, args, options) => {
    assert.equal(command, "powershell.exe");
    assert.equal(options.windowsHide, true);
    assert.match(args.at(-1), /2147483649/);
    assert.match(args.at(-1), /finally.*2147483648/);
    assert.doesNotMatch(args.at(-1), /powercfg|ExecutionPolicy|2147483651/);
    queueMicrotask(() => child.stdout.emit("data", "system-required\n"));
    return child;
  };
  const release = await preventIdleSleep({ platform: "win32", start });
  assert.equal(release.active(), true);
  assert.deepEqual(calls, []);
  release();
  release();
  assert.equal(release.active(), false);
  assert.deepEqual(calls, ["released"]);
});

test("an exited wake helper is observable so the recurring runner can reacquire its request", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = { resume() {} };
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  const release = await preventIdleSleep({ platform: "win32", start: () => {
    queueMicrotask(() => child.stdout.emit("data", "system-required\n"));
    return child;
  } });
  assert.equal(release.active(), true);
  child.emit("close", 1);
  assert.equal(release.active(), false);
  release();
});

test("non-Windows runners are untouched and unavailable wake helpers fail visibly", async () => {
  (await preventIdleSleep({ platform: "linux", start: () => assert.fail("No helper on Linux") }))();
  await assert.rejects(preventIdleSleep({ platform: "win32", start: () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = { resume() {} };
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    queueMicrotask(() => child.emit("error", new Error("Unavailable")));
    return child;
  } }), /wake helper unavailable/);
});
