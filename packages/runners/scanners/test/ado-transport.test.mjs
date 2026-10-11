import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createAdoTransport, readAdoMetrics, accessToken, clearToken, getJson } from "../lib/ado-transport.mjs";
import { survey } from "../pr-updater/lib/survey.mjs";
import { conflicted, baseConfig, NOW } from "../pr-updater/test/fixtures.mjs";

const url = "https://dev.azure.com/example/project/_apis/git/repositories/repo/pullRequests";
const token = "test-credential";
const options = { token, cacheMs: 60_000, metric: "GET PRs" };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data),
  { status, headers: { "content-type": "application/json", ...headers } });
async function temp(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ado-cache-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("two clients share a cached response and record actual requests, not just calls", async (t) => {
  const directory = await temp(t);
  let calls = 0;
  const fetchImpl = async () => { calls++; await sleep(30); return json({ value: [1] }); };
  const first = createAdoTransport({ directory, fetchImpl });
  const second = createAdoTransport({ directory, fetchImpl });
  assert.deepEqual(await Promise.all([first.request(url, options), second.request(url, options)]),
    [{ value: [1] }, { value: [1] }]);
  assert.equal(calls, 1);
  const [metrics] = await readAdoMetrics(directory);
  assert.equal(metrics.networkRequests, 1);
  assert.equal(metrics.cacheHits, 1);
  assert.equal(metrics.endpoints["GET PRs"].statuses[200], 1);
  const files = await readdir(path.join(directory, metrics.scope));
  for (const file of files) assert.equal((await readFile(path.join(directory, metrics.scope, file), "utf8")).includes(token), false);
});

test("fresh-read booleans and explicit credential-refresh callbacks remain distinct", async () => {
  assert.deepEqual(await getJson(url, token, async () => json({ fresh: true }), true), { fresh: true });
  let requests = 0, refreshes = 0;
  assert.deepEqual(await getJson(url, token, async () => ++requests === 1 ? json({}, 401) : json({ refreshed: true }),
    async () => { refreshes++; return token; }), { refreshed: true });
  assert.equal(refreshes, 1);
  assert.throws(() => getJson(url, token, undefined, "invalid"), /callback or boolean/);
});

test("paired 11-PR surveys preserve fleet decisions while reducing 46 reads to 23", async (t) => {
  const directory = await temp(t);
  const prs = Array.from({ length: 11 }, (_, i) => ({ ...conflicted, id: String(1000000 + i), mergeStatus: "succeeded" }));
  let calls = 0;
  const fetchImpl = async (requested) => { calls++; return json(requested === url ? prs : []); };
  for (const index of [0, 1]) {
    const transport = createAdoTransport({ directory, fetchImpl });
    const ado = {
      listOwnPullRequests: () => transport.request(url, options),
      listThreads: (_config, id) => transport.request(`${url}/${id}/threads`, options),
      listBuilds: (_config, id) => transport.request(`${url}/${id}/policies`, options),
    };
    const rows = await survey({ config: { ...baseConfig(null), shard: { index, total: 2 } }, state: {}, now: NOW, ado });
    assert.equal(rows.length, 11);
    assert.ok(rows.every((entry) => entry.verdict === null));
  }
  assert.equal(calls, 23);
  assert.equal((await readAdoMetrics(directory))[0].cacheHits, 23);
});

test("expired entries and explicit fresh reads hit the server; identities never share cache", async (t) => {
  const directory = await temp(t);
  let clock = 1_000_000, calls = 0;
  const transport = createAdoTransport({ directory, now: () => clock, fetchImpl: async () => json(++calls) });
  assert.equal(await transport.request(url, options), 1);
  assert.equal(await transport.request(url, options), 1);
  assert.equal(await transport.request(url, { ...options, token: "other-identity" }), 2);
  assert.equal(await transport.request(url, { ...options, cacheMs: 0 }), 3);
  clock += 60_000;
  assert.equal(await transport.request(url, options), 4);
});

test("writes invalidate affected reads and are never cached or automatically replayed", async (t) => {
  const directory = await temp(t);
  let calls = 0;
  const transport = createAdoTransport({ directory, fetchImpl: async () => json(++calls) });
  await transport.request(url, options);
  await transport.request(`${url}/1`, { token, method: "PATCH", body: { status: "closed" }, invalidate: [url] });
  assert.equal(await transport.request(url, options), 3);
  await transport.request(`${url}/1`, { token, method: "PATCH" });
  assert.equal(calls, 4);
  let writes = 0;
  const broken = createAdoTransport({ directory, fetchImpl: async () => { writes++; return json({}, 503); } });
  await assert.rejects(broken.request(`${url}/2`, { token, method: "PATCH" }), /503/);
  assert.equal(writes, 1);
});

for (const status of [200, 429, 503]) {
  test(`Retry-After on HTTP ${status} prevents another process's next request`, async (t) => {
    const directory = await temp(t);
    let clock = 1_000_000, calls = 0;
    const fetchImpl = async () => { calls++; return json({}, status, { "retry-after": "120", "x-ratelimit-remaining": "0" }); };
    const a = createAdoTransport({ directory, fetchImpl, now: () => clock });
    const b = createAdoTransport({ directory, fetchImpl, now: () => clock });
    if (status === 200) await a.request(url, options);
    else await assert.rejects(a.request(url, options), (e) => e.retryAfterMs === 120_000);
    await assert.rejects(b.request(`${url}/new`, options), (e) => e.code === "ADO_COOLDOWN" && e.retryAfterMs === 120_000);
    assert.equal(calls, 1);
    const [metrics] = await readAdoMetrics(directory);
    assert.equal(metrics.lastRateLimit["x-ratelimit-remaining"], "0");
    clock += 120_001;
    if (status === 200) await b.request(`${url}/new`, options);
    else await assert.rejects(b.request(`${url}/new`, options));
    assert.equal(calls, 2);
  });
}

test("a rejected GET refreshes once, but authentication failures never replay writes", async (t) => {
  const directory = await temp(t);
  let calls = 0, refreshes = 0;
  const transport = createAdoTransport({ directory, fetchImpl: async () => ++calls === 1 ? json({}, 401) : json({ ok: true }) });
  assert.deepEqual(await transport.request(url, { ...options, refresh: async () => { refreshes++; return token; } }), { ok: true });
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
  const bad = createAdoTransport({ directory, fetchImpl: async () => json({}, 401) });
  await assert.rejects(bad.request(`${url}/1`, { token, method: "PATCH", refresh: () => { throw new Error("must not refresh"); } }),
    (e) => e.tokenRejected);
});

test("rate limiting without Retry-After backs off and does not cache errors", async (t) => {
  const directory = await temp(t);
  let clock = 1_000_000, calls = 0;
  const transport = createAdoTransport({ directory, now: () => clock, fetchImpl: async () => ++calls === 1 ? json({}, 429) : json("ok") });
  await assert.rejects(transport.request(url, options), (e) => e.retryAfterMs === 30_000);
  await assert.rejects(transport.request(url, options), /deferred/);
  clock += 30_001;
  assert.equal(await transport.request(url, options), "ok");
  assert.equal(calls, 2);
});

test("ADO service and legacy host aliases share an organization's cooldown", async (t) => {
  const directory = await temp(t);
  let calls = 0;
  const transport = createAdoTransport({ directory, fetchImpl: async () => { calls++; return json({}, 429); } });
  await assert.rejects(transport.request(url, options), /429/);
  for (const alias of [
    "https://vssps.dev.azure.com/example/_apis/identities",
    "https://example.visualstudio.com/project/_apis/git/repositories",
  ]) await assert.rejects(transport.request(alias, options), /deferred/);
  assert.equal(calls, 1);
  await assert.rejects(transport.request("https://dev.azure.com/other/project/_apis/build/builds", options), /429/);
  assert.equal(calls, 2, "another organization has a separate quota");
});

test("timeout releases the lock and shares a network-error cooldown", async (t) => {
  const directory = await temp(t);
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const local = `http://127.0.0.1:${server.address().port}/slow`;
  const transport = createAdoTransport({ directory, requestTimeoutMs: 80 });
  await assert.rejects(transport.request(local, options), (e) => e.name === "TimeoutError");
  await assert.rejects(transport.request(local, options), /deferred/);
});

test("separate Node processes coalesce the same URL through the shared on-disk lock", async (t) => {
  const directory = await temp(t);
  let calls = 0;
  const server = http.createServer(async (_req, res) => {
    calls++;
    await sleep(100);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const local = `http://127.0.0.1:${server.address().port}/shared`;
  const moduleUrl = new URL("../lib/ado-transport.mjs", import.meta.url).href;
  const script = `import {createAdoTransport} from ${JSON.stringify(moduleUrl)};
    await createAdoTransport({directory:${JSON.stringify(directory)}}).request(${JSON.stringify(local)},${JSON.stringify(options)});`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([run(), run()]);
  assert.equal(calls, 1);
});

test("token lifetime follows JWT expiry instead of assuming 45 minutes remain", () => {
  clearToken();
  const clock = 1_000_000;
  const jwt = `header.${Buffer.from(JSON.stringify({ exp: (clock + 90_000) / 1000 })).toString("base64url")}.signature`;
  let calls = 0;
  const execute = () => { calls++; return jwt; };
  accessToken(clock, execute);
  accessToken(clock + 20_000, execute);
  assert.equal(calls, 1);
  accessToken(clock + 31_000, execute);
  assert.equal(calls, 2);
  clearToken();
});

test("zero remaining quota honors the reset time even on a successful response", async (t) => {
  const directory = await temp(t);
  const clock = 1_000_000;
  const transport = createAdoTransport({ directory, now: () => clock, fetchImpl: async () =>
    json({}, 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((clock + 90_000) / 1000) }) });
  await transport.request(url, options);
  await assert.rejects(transport.request(`${url}/2`, options), (e) => e.retryAfterMs === 90_000);
});

test("short Retry-After pacing on HTTP 200 waits and continues instead of starving the survey", async (t) => {
  const directory = await temp(t);
  const requestedAt = [];
  const transport = createAdoTransport({ directory, fetchImpl: async () => {
    requestedAt.push(Date.now());
    return json({}, 200, requestedAt.length === 1 ? { "retry-after": "0.1" } : {});
  } });
  await transport.request(url, options);
  await transport.request(`${url}/next`, options);
  assert.equal(requestedAt.length, 2);
  assert.ok(requestedAt[1] - requestedAt[0] >= 99);
});

test("fresh reads invalidate older cached evidence", async (t) => {
  const directory = await temp(t);
  let calls = 0;
  const transport = createAdoTransport({ directory, fetchImpl: async () => json(++calls) });
  assert.equal(await transport.request(url, options), 1);
  assert.equal(await transport.request(url, { ...options, cacheMs: 0 }), 2);
  assert.equal(await transport.request(url, options), 3);
});

test("identity changes during refresh cannot publish another user's data into the old cache", async (t) => {
  const directory = await temp(t);
  let calls = 0;
  const transport = createAdoTransport({ directory, fetchImpl: async () => { calls++; return json({}, 401); } });
  await assert.rejects(transport.request(url, { ...options, refresh: () => "different-identity" }), /identity changed/);
  assert.equal(calls, 1);
});

test("concurrent clients recover an exited process's lock without duplicate requests", async (t) => {
  const directory = await temp(t);
  let calls = 0;
  const transport = createAdoTransport({ directory, fetchImpl: async () => { calls++; await sleep(10); return json(calls); } });
  await transport.request(url, options);
  const [report] = await readAdoMetrics(directory);
  const pid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { windowsHide: true });
    child.on("error", reject);
    child.on("exit", () => resolve(child.pid));
  });
  const lock = path.join(directory, report.scope, "request.lock");
  await mkdir(lock);
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid }));
  await Promise.all(Array.from({ length: 4 }, () => transport.request(`${url}/fresh`, options)));
  assert.equal(calls, 2);
});
