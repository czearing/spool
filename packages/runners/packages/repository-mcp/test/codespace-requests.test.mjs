import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodespaceRequests, codespaceConnectionFailure } from "../src/codespaces/github-requests.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-requests-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let time = 1_800_000_000_000;
  const options = { directory, now: () => time };
  return { options, advance: ms => { time += ms; }, now: () => time,
    client: run => new CodespaceRequests("fixture", { ...options, run }) };
}
const ssh = name => ["codespace", "ssh", "-c", name, "--", "true"];
const reply = (state, reset = 1_800_003_600) => ({
  stdout: `HTTP/2.0 200 OK\r\nX-Ratelimit-Reset: ${reset}\r\n\r\n${JSON.stringify({ state })}`,
});

test("connection recovery classifies capacity and transport failures without retrying identity or permission errors", t => {
  const f = fixture(t), client = f.client(async () => reply("Available"));
  for (const message of ["You have too many codespaces running. Please stop some and try again.",
    "Connection reset by peer", "ssh: connect to host example: Connection timed out",
    "SSH command channel closed (255)", "CODESPACE_WORKSPACE_BUSY",
    "Copilot ACP startup failed: [Copilot ACP setup] Codespace workspace is busy with another operation; retry after it finishes. Log: lease.log: Copilot ACP closed its output"]) {
    assert.ok(codespaceConnectionFailure(new Error(message)), message);
    const error = new Error(message);
    client.failed(error, "one");
    assert.throws(() => client.check("one"), { code: "CODESPACE_UNAVAILABLE" });
    assert.doesNotThrow(() => client.check("another-space"));
    client.connected("one");
  }
  for (const message of ["Permission denied (publickey)", "HTTP 401: Bad credentials",
    "Remote review lease is no longer held", "Remote revision changed; handoff blocked",
    "Codespace preparation is not ready", "Copilot ACP closed its output",
    "SSH command channel closed (255): Permission denied (publickey)",
    "Remote revision changed; cleanup: Connection reset by peer",
    "Codespace workspace is busy with another operation; Permission denied (publickey)"])
    assert.equal(codespaceConnectionFailure(new Error(message)), null, message);
});

test("metadata caching is shared across clients, expires, and does not cache connection commands", async t => {
  const f = fixture(t);
  let calls = 0;
  const run = async () => { calls++; return reply("Available"); };
  assert.equal(JSON.parse((await f.client(run).request(["api", "user/codespaces/fixture"])).stdout).state, "Available");
  await f.client(run).request(["api", "user/codespaces/fixture"]);
  assert.equal(calls, 1);
  f.advance(60_001);
  await f.client(run).request(["api", "user/codespaces/fixture"]);
  await f.client(run).request(ssh("fixture"));
  await f.client(run).request(ssh("fixture"));
  assert.equal(calls, 4);
});

test("rate limits block other clients and Codespaces until the actual response reset", async t => {
  const f = fixture(t);
  const reset = f.now() / 1000 + 300;
  await assert.rejects(f.client(async () => { throw new Error(
    `HTTP 403: API rate limit exceeded\nx-ratelimit-remaining: 0\nx-ratelimit-reset: ${reset}\n`,
  ); }).request(ssh("one")), /rate limit exceeded/);
  let calls = 0;
  const second = f.client(async () => { calls++; return { stdout: "connected" }; });
  f.advance(60_001);
  await assert.rejects(second.request(ssh("two")), error => error.code === "GITHUB_RATE_LIMITED");
  assert.equal(calls, 0);
  f.advance(240_000);
  await second.request(ssh("two"));
  assert.equal(calls, 1);
});

test("starting a stopped Codespace invalidates shared shutdown metadata without clearing connection failures", async t => {
  const f = fixture(t), calls = [];
  const client = f.client(async (_command, args) => {
    calls.push(args);
    return args[1].endsWith("/start") ? { stdout: "" } : reply(calls.length === 1 ? "Shutdown" : "Starting");
  });
  assert.equal(JSON.parse((await client.request(["api", "user/codespaces/one"])).stdout).state, "Shutdown");
  client.failed(new Error("SSH command channel startup timed out before any commands were sent"), "one");
  f.advance(15_001);
  await client.request(["api", "user/codespaces/one/start", "--method", "POST"]);
  assert.equal(JSON.parse((await client.request(["api", "user/codespaces/one"])).stdout).state, "Starting");
  assert.equal(calls.length, 3);
  assert.equal(client.read("connection:one").requireConnection, true);
});

test("SSH throttling uses previously observed Codespaces reset headers", async t => {
  const f = fixture(t);
  await f.client(async () => reply("Shutdown", f.now() / 1000 + 1200))
    .request(["api", "user/codespaces/one"]);
  await assert.rejects(f.client(async () => { throw new Error("HTTP 403: API rate limit exceeded"); })
    .request(ssh("one")));
  f.advance(900_001);
  assert.throws(() => f.client(async () => {}).check("two"), error => error.code === "GITHUB_RATE_LIMITED");
});

test("Retry-After is respected and repeated throttling increases the shared backoff", async t => {
  const f = fixture(t);
  const first = f.client(async () => { throw new Error("HTTP 429\nRetry-After: 120"); });
  await assert.rejects(first.request(ssh("one")));
  f.advance(60_001);
  await assert.rejects(first.request(ssh("one")), error => error.code === "GITHUB_RATE_LIMITED");
  f.advance(60_000);
  await assert.rejects(f.client(async () => { throw new Error("HTTP 403: secondary rate limit"); }).request(ssh("two")));
  f.advance(60_001);
  assert.throws(() => first.check(), error => error.code === "GITHUB_RATE_LIMITED");
});

test("failed starts back off only that Codespace and an available metadata probe recovers it", async t => {
  const f = fixture(t);
  await assert.rejects(f.client(async () => { throw new Error("error starting codespace: HTTP 400: 39"); })
    .request(ssh("broken")));
  const next = f.client(async () => ({ stdout: "connected" }));
  await assert.rejects(next.request(ssh("broken")), error => error.code === "CODESPACE_UNAVAILABLE");
  await next.request(ssh("healthy"));
  await f.client(async () => reply("Available")).request(["api", "user/codespaces/broken"]);
  await next.request(ssh("broken"));
});

test("permission failures do not throttle other requests or get cached as metadata", async t => {
  const f = fixture(t);
  await assert.rejects(f.client(async () => { throw new Error("HTTP 403: Resource not accessible"); })
    .request(["api", "user/codespaces/one"]));
  const result = await f.client(async () => reply("Available")).request(["api", "user/codespaces/one"]);
  assert.equal(JSON.parse(result.stdout).state, "Available");
});

test("available metadata and unrelated API requests cannot clear a failed SSH-server cooldown", async t => {
  const f = fixture(t);
  await assert.rejects(f.client(async () => { throw new Error(
    "error getting ssh server details: failed to start SSH server",
  ); }).request(ssh("broken")));
  const next = f.client(async () => ({ stdout: "connected" }));
  await f.client(async () => reply("Available")).request(["api", "user/codespaces/broken"]);
  assert.throws(() => next.check("broken"), error => error.code === "CODESPACE_UNAVAILABLE");
  await next.request(ssh("healthy"));
  f.advance(15_001);
  await next.request(["codespace", "ports", "-c", "broken"]);
  assert.equal(next.read("connection:broken").requireConnection, true);
  await next.request(ssh("broken"));
  assert.deepEqual(next.read("connection:broken"), {});
});

test("a command-channel bootstrap timeout defers retry before any input can be sent", async t => {
  const f = fixture(t), client = f.client(async () => ({ stdout: "connected" }));
  client.failed(new Error("SSH command channel startup timed out before any commands were sent"), "one");
  assert.throws(() => client.check("one"), error => error.code === "CODESPACE_UNAVAILABLE");
  assert.equal(client.read("connection:one").requireConnection, true);
});

test("connection backoff permits read-only Codespace diagnosis but still blocks starts and respects API rate limits", async t => {
  const f = fixture(t), client = f.client(async () => ({ stdout: "{}" }));
  client.failed(new Error("SSH command channel startup timed out before any commands were sent"), "one");
  await client.request(["api", "user/codespaces/one", "--method", "GET"]);
  await client.request(["api", "user/codespaces/one/machines"]);
  await assert.rejects(client.request(["api", "user/codespaces/one/start", "--method", "POST"]),
    { code: "CODESPACE_UNAVAILABLE" });
  client.failed(new Error("HTTP 429"), "one");
  await assert.rejects(client.request(["api", "user/codespaces/one/machines"]), { code: "GITHUB_RATE_LIMITED" });
});

test("native ACP setup markers retain connection and account-wide cooldown semantics", t => {
  for (const marker of ["CODESPACE_UNAVAILABLE", "CODESPACE_SHUTTING_DOWN", "GITHUB_RATE_LIMITED"]) {
    const f = fixture(t), client = f.client(async () => ({ stdout: "connected" }));
    client.failed(new Error(`[Copilot ACP setup] ${marker} retryAt=2026-11-03T21:51:19.878Z`), "one");
    const expected = marker === "GITHUB_RATE_LIMITED" ? "GITHUB_RATE_LIMITED" : "CODESPACE_UNAVAILABLE";
    assert.throws(() => client.check("one"), error => error.code === expected);
    if (marker === "GITHUB_RATE_LIMITED")
      assert.throws(() => client.check("two"), error => error.code === expected);
    else client.check("two");
    if (marker === "CODESPACE_UNAVAILABLE") assert.equal(client.read("connection:one").requireConnection, true);
  }
  assert.equal(codespaceConnectionFailure("Remote command failed (124): command timed out"), null);
});

test("a shutting-down Codespace defers admission without throttling another environment", async t => {
  const f = fixture(t), client = f.client(async () => ({ stdout: "connected" }));
  client.failed(new Error("Assigned Codespace is shutting down; retry the original task after it is available"), "one");
  assert.throws(() => client.check("one"), error => error.code === "CODESPACE_UNAVAILABLE");
  client.check("two");
  f.advance(15_001);
  client.check("one");
});

test("secondary limits do not wait for an unrelated primary reset and success resets their backoff", async t => {
  const f = fixture(t);
  await f.client(async () => reply("Available")).request(["api", "user/codespaces/one"]);
  const failure = f.client(async () => { throw new Error("HTTP 403: secondary rate limit"); });
  await assert.rejects(failure.request(ssh("one")));
  f.advance(60_001);
  await f.client(async () => ({ stdout: "connected" })).request(ssh("one"));
  await assert.rejects(failure.request(ssh("one")));
  f.advance(60_001);
  await f.client(async () => ({ stdout: "connected" })).request(ssh("one"));
});

test("an already in-flight successful request cannot clear another client's new cooldown", async t => {
  const f = fixture(t);
  let release;
  const pending = f.client(() => new Promise(resolve => { release = resolve; })).request(ssh("one"));
  await assert.rejects(f.client(async () => { throw new Error("HTTP 403: API rate limit exceeded"); })
    .request(ssh("two")));
  release({ stdout: "connected" });
  await pending;
  assert.throws(() => f.client(async () => {}).check(), error => error.code === "GITHUB_RATE_LIMITED");
});

test("concurrent metadata lookups share one request across independent clients", async t => {
  const f = fixture(t);
  let calls = 0;
  const run = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 80));
    return reply("Available");
  };
  const responses = await Promise.all(Array.from({ length: 5 }, () =>
    f.client(run).request(["api", "user/codespaces/one"])));
  assert.equal(calls, 1);
  assert.ok(responses.every(response => JSON.parse(response.stdout).state === "Available"));
  assert.equal(fs.readdirSync(f.options.directory).some(name => name.endsWith(".lock")), false);
});

test("request diagnostics identify operations without recording command arguments or credentials", async t => {
  const f = fixture(t);
  await f.client(async () => ({ stdout: "secret-output" }))
    .request(["codespace", "ssh", "-c", "one", "--", "private-command"], { env: { GH_TOKEN: "private-token" } });
  const log = fs.readFileSync(path.join(f.options.directory,
    fs.readdirSync(f.options.directory).find(name => name.endsWith(".jsonl"))), "utf8");
  assert.match(log, /ssh-connect/);
  assert.doesNotMatch(log, /private-command|private-token|secret-output/);
});
