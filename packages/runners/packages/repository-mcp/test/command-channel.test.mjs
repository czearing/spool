import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { CommandChannel, commandServer } from "../src/codespaces/command-channel.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";

function fixture(t) {
  const child = new EventEmitter();
  for (const stream of ["stdin", "stdout", "stderr"]) child[stream] = new PassThrough();
  const requests = [];
  const lines = createInterface({ input: child.stdin });
  lines.on("line", line => requests.push(JSON.parse(line)));
  const channel = new CommandChannel(child);
  const reply = value => child.stdout.write(JSON.stringify(value) + "\n");
  reply({ ready: true });
  t.after(() => {
    child.emit("close", 0);
    lines.close();
    for (const stream of ["stdin", "stdout", "stderr"]) child[stream].destroy();
  });
  return { child, channel, requests, reply };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("remote observation servers exit on explicit shutdown even if SSH has not delivered stdin EOF", async t => {
  const child = spawn(process.execPath, ["-e", `(${commandServer.toString()})()`],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const [ready] = await once(lines, "line", { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(JSON.parse(ready), { ready: true });
  const closed = once(child, "close", { signal: AbortSignal.timeout(5000) });
  child.stdin.write('{"shutdown":true}\n');
  const [code] = await closed;
  assert.equal(code, 0);
});

test("closing a healthy channel sends shutdown without replaying commands", async t => {
  const f = fixture(t);
  f.child.stdin.once("finish", () => f.child.emit("close", 0));
  await f.channel.close();
  assert.deepEqual(f.requests, [{ shutdown: true }]);
});

test("one channel carries multiple commands with isolated output and exact binary input", async t => {
  const f = fixture(t);
  const first = f.channel.run("first", { input: Buffer.from([0, 255, 13, 10]) });
  const second = f.channel.run("second");
  await tick();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(Buffer.from(f.requests[0].input, "base64"), Buffer.from([0, 255, 13, 10]));
  const [a, b] = f.requests;
  f.reply({ id: b.id, stream: "stdout", data: Buffer.from("second").toString("base64") });
  f.reply({ id: a.id, stream: "stdout", data: Buffer.from("✓").subarray(0, 1).toString("base64") });
  f.reply({ id: a.id, stream: "stdout", data: Buffer.from("✓").subarray(1).toString("base64") });
  f.reply({ id: b.id, code: 0 });
  f.reply({ id: a.id, code: 0 });
  assert.equal((await first).stdout, "✓");
  assert.equal((await second).stdout, "second");
});

test("a failed remote command is reported without replaying it or breaking another command", async t => {
  const f = fixture(t);
  const failed = assert.rejects(f.channel.run("mutating command"), /Remote command failed \(7\)\noriginal failure/);
  await tick();
  const { id } = f.requests[0];
  f.reply({ id, stream: "stderr", data: Buffer.from("original failure").toString("base64") });
  f.reply({ id, code: 7 });
  await failed;
  const next = f.channel.run("read");
  await tick();
  f.reply({ id: f.requests[1].id, code: 0 });
  await next;
  assert.deepEqual(f.requests.map(row => row.command), ["mutating command", "read"]);
});

test("connection loss rejects pending work and never silently reconnects or replays it", async t => {
  const f = fixture(t);
  const pending = assert.rejects(f.channel.run("do not replay"), /channel closed/);
  await tick();
  f.child.stderr.write("connection lost");
  f.child.emit("close", 255);
  await pending;
  await assert.rejects(f.channel.run("next"), /connection lost/);
  assert.equal(f.requests.length, 1);
});

test("startup rate-limit text reaches the shared cooldown handler", async t => {
  const child = new EventEmitter();
  for (const stream of ["stdin", "stdout", "stderr"]) child[stream] = new PassThrough();
  const failures = [];
  const channel = new CommandChannel(child, { onFailure: error => failures.push(error.message) });
  const pending = assert.rejects(channel.run("not started"), /rate limit exceeded/);
  child.stderr.write("HTTP 403: API rate limit exceeded");
  child.emit("close", 1);
  await pending;
  assert.equal(failures.length, 1);
  assert.match(failures[0], /HTTP 403: API rate limit exceeded/);
  for (const stream of ["stdin", "stdout", "stderr"]) child[stream].destroy();
});

test("a connection that never starts expires without sending or replaying a command", async () => {
  const child = new EventEmitter();
  for (const stream of ["stdin", "stdout", "stderr"]) child[stream] = new PassThrough();
  let closed = 0;
  child.kill = () => { closed++; child.emit("close", null); };
  const channel = new CommandChannel(child, { startupTimeoutMs: 10 });
  await assert.rejects(channel.run("not started"), /startup timed out before any commands were sent/);
  assert.equal(child.stdin.readableLength, 0);
  await assert.rejects(channel.run("do not replay"), /startup timed out/);
  await channel.close();
  assert.equal(closed, 1);
  for (const stream of ["stdin", "stdout", "stderr"]) child[stream].destroy();
});
