import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireProcessLock } from "../../packages/bohemia-agent-tooling/src/index.js";

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const cacheRoot = fileURLToPath(new URL("../.runner/ado-cache/", import.meta.url));
let credential = { token: null, expiresAt: 0 };

function claims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); }
  catch { return {}; }
}

export function accessToken(now = Date.now(), execute = execSync) {
  if (credential.token && now < credential.expiresAt - 60_000) return credential.token;
  const token = String(execute(
    `az account get-access-token --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47 --resource ${ADO_RESOURCE} --query accessToken --output tsv`,
    { encoding: "utf8", timeout: 120_000, windowsHide: true },
  )).trim();
  if (!token) throw new Error("az returned an empty access token");
  const expiry = Number(claims(token).exp) * 1000;
  credential = { token, expiresAt: Number.isFinite(expiry) && expiry > now ? expiry : now + 5 * 60_000 };
  return token;
}

export function clearToken() { credential = { token: null, expiresAt: 0 }; }
export function authHeaders(token) {
  return { Authorization: ["Bearer", token].join(" "), "content-type": "application/json" };
}
export function rejectedToken(message) {
  return Object.assign(new Error(message), { tokenRejected: true });
}

const hash = (text) => createHash("sha256").update(text).digest("hex");
async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}
async function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, file); break; }
      catch (error) {
        if (!["EPERM", "EBUSY"].includes(error.code) || attempt >= 8) throw error;
        await sleep(25 * (attempt + 1));
      }
    }
  } finally { await rm(temp, { force: true }); }
}

// Neither tokens nor claim values are persisted. Scope entries by identity AND permission set.
function scopeFor(url, token) {
  const c = claims(token);
  const identity = c.oid && c.tid
    ? JSON.stringify([c.oid, c.tid, c.aud, c.appid || c.azp, c.scp, c.roles])
    : token;
  const u = new URL(url);
  let account = u.origin;
  if (["dev.azure.com", "vssps.dev.azure.com"].includes(u.hostname)) {
    account = `ado:${u.pathname.split("/")[1].toLowerCase()}`;
  } else if (u.hostname.endsWith(".visualstudio.com")) {
    account = `ado:${u.hostname.split(".")[0].toLowerCase()}`;
  }
  return hash(`${account}:${identity}`);
}

async function acquireLock(directory, timeoutMs) {
  const canonical = process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory);
  return acquireProcessLock(canonical, { namespace: "ado-request", timeoutMs });
}

function retryDelay(headers, now) {
  const value = headers?.get?.("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : (Date.parse(value) || now) - now);
}

function cooldownError(until, now) {
  return Object.assign(new Error(`Azure DevOps requests deferred until ${new Date(until).toISOString()}`),
    { retryAfterMs: Math.max(0, until - now), code: "ADO_COOLDOWN" });
}

/**
 * One lock per identity/organization coalesces reads across processes and serializes writes.
 * Errors never fall back to stale cache or an uncoordinated request. Writes are never replayed.
 */
export function createAdoTransport({
  directory = cacheRoot, fetchImpl = fetch, now = Date.now,
  requestTimeoutMs = 30_000, lockTimeoutMs = 150_000, maxInlineDelayMs = 30_000,
} = {}) {
  return {
    async request(url, options = {}) {
      let token = options.token || accessToken();
      const scope = path.join(directory, scopeFor(url, token));
      await mkdir(scope, { recursive: true, mode: 0o700 });
      const release = await acquireLock(scope, lockTimeoutMs);
      const metricsFile = path.join(scope, "metrics.json");
      const controlFile = path.join(scope, "control.json");
      const cacheFile = (key) => path.join(scope, `${hash(key)}.json`);
      let metrics;
      try {
        metrics = await readJson(metricsFile, {
          startedAt: new Date(now()).toISOString(), networkRequests: 0, cacheHits: 0,
          cacheMisses: 0, errors: 0, throttles: 0, authRefreshes: 0,
          responseBytes: 0, durationMs: 0, endpoints: {},
        });
        const method = options.method || "GET";
        const metric = options.metric || `${method} other`;
        const counters = metrics.endpoints[metric] ??= { networkRequests: 0, cacheHits: 0, statuses: {} };
        const control = await readJson(controlFile, { notBefore: 0, failures: 0 });
        const ttl = method === "GET" ? Math.max(0, options.cacheMs || 0) : 0;
        const cached = ttl ? await readJson(cacheFile(url)) : null;
        if (cached && cached.fetchedAt <= now() && now() - cached.fetchedAt < ttl
          && cached.expiresAt > now()) {
          metrics.cacheHits++;
          counters.cacheHits++;
          return cached.payload;
        }
        if (control.notBefore > now()) {
          const remaining = control.notBefore - now();
          // Short pacing hints on successful responses must not abort and restart the
          // whole survey at its first URL every cycle. Long/error cooldowns defer the cycle.
          if (control.pace && remaining <= maxInlineDelayMs) await sleep(remaining);
          else throw cooldownError(control.notBefore, now());
        }
        if (ttl) metrics.cacheMisses++;
        if (method === "GET" && !ttl) await rm(cacheFile(url), { force: true });
        for (const key of options.invalidate || []) await rm(cacheFile(key), { force: true });

        for (let attempt = 0; ; attempt++) {
          const started = now();
          metrics.networkRequests++;
          counters.networkRequests++;
          let response;
          try {
            response = await (options.fetchImpl || fetchImpl)(url, {
              method, headers: authHeaders(token), redirect: "manual",
              ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
              signal: AbortSignal.timeout(requestTimeoutMs),
            });
          } catch (error) {
            control.failures++;
            control.pace = false;
            control.notBefore = now() + Math.min(300_000, 5_000 * 2 ** Math.min(control.failures - 1, 6));
            await atomicJson(controlFile, control);
            throw Object.assign(error, { retryAfterMs: control.notBefore - now() });
          }
          counters.statuses[response.status] = (counters.statuses[response.status] || 0) + 1;
          const headers = response.headers;
          metrics.lastRateLimit = Object.fromEntries(
            ["retry-after", "x-ratelimit-remaining", "x-ratelimit-limit", "x-ratelimit-reset", "x-ratelimit-delay", "x-ratelimit-cost"]
              .map((key) => [key, headers?.get?.(key) ?? null]),
          );
          const remaining = headers?.get?.("x-ratelimit-remaining");
          const reset = Number(headers?.get?.("x-ratelimit-reset")) * 1000;
          const exhaustedDelay = remaining !== null && remaining !== undefined && Number(remaining) === 0
            ? Math.max(30_000, Number.isFinite(reset) ? reset - now() : 0) : 0;
          const delay = Math.max(retryDelay(headers, now()), exhaustedDelay);
          control.pace = response.status === 200 && delay > 0;
          if (delay > 0 || response.status === 429 || response.status >= 500) {
            control.failures++;
            const fallback = Math.min(300_000, 30_000 * 2 ** Math.min(control.failures - 1, 4));
            control.notBefore = now() + (delay || fallback);
            if (delay || response.status === 429) metrics.throttles++;
          } else {
            control.failures = 0;
            control.notBefore = 0;
          }
          await atomicJson(controlFile, control);
          let payload;
          try {
            const contentType = headers?.get?.("content-type") || "";
            const authFailure = response.status === 401 || response.status === 403
              || [203, 301, 302, 303, 307, 308].includes(response.status)
              || (response.ok && contentType && !contentType.includes("json"));
            if (authFailure) {
              clearToken();
              await response.body?.cancel?.();
              // A write may already have been applied; only rejected reads can be refreshed once.
              if (method === "GET" && attempt === 0 && !delay) {
                token = await (options.refresh || accessToken)();
                metrics.authRefreshes++;
                if (path.join(directory, scopeFor(url, token)) !== scope) {
                  // Retry in a new cycle under the new identity's lock/cache, not the old scope.
                  throw new Error("Azure DevOps identity changed during token refresh; retry the scan");
                }
                continue;
              }
              control.failures++;
              control.pace = false;
              control.notBefore = Math.max(control.notBefore, now() + 60_000);
              await atomicJson(controlFile, control);
              throw rejectedToken(`Azure DevOps token was not accepted (${response.status})`);
            }
            if (!response.ok) {
              await response.body?.cancel?.();
              throw Object.assign(new Error(`Azure DevOps ${response.status} for ${new URL(url).pathname}`),
                { status: response.status, retryAfterMs: Math.max(0, control.notBefore - now()) });
            }
            if (response.status === 204) payload = null;
            else if (response.text) {
              const text = await response.text();
              metrics.responseBytes += Buffer.byteLength(text);
              payload = text ? JSON.parse(text) : null;
            } else payload = await response.json();
          } finally { metrics.durationMs += Math.max(0, now() - started); }
          if (ttl) await atomicJson(cacheFile(url), {
            fetchedAt: now(), expiresAt: now() + ttl, payload,
          });
          return payload;
        }
      } catch (error) {
        if (metrics) metrics.errors++;
        throw error;
      } finally {
        try {
          if (metrics) {
            metrics.updatedAt = new Date(now()).toISOString();
            await atomicJson(metricsFile, metrics);
          }
        } finally { await release(); }
      }
    },
  };
}

const shared = createAdoTransport();

// Injected endpoint tests must not acquire credentials, persist cache, or share production quotas.
async function injectedRequest(url, options) {
  const method = options.method || "GET";
  let token = options.token || accessToken();
  for (let attempt = 0; ; attempt++) {
    const response = await options.fetchImpl(url, {
      method, headers: authHeaders(token),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(30_000), redirect: "manual",
    });
    const contentType = response.headers?.get?.("content-type") || "";
    if ([401, 403, 203, 301, 302, 303, 307, 308].includes(response.status)
      || (response.ok && contentType && !contentType.includes("json"))) {
      clearToken();
      if (method === "GET" && attempt === 0) { token = await (options.refresh || accessToken)(); continue; }
      throw rejectedToken(`Azure DevOps token was not accepted (${response.status})`);
    }
    if (!response.ok) throw Object.assign(new Error(`Azure DevOps ${response.status} for ${url}`),
      { status: response.status, retryAfterMs: retryDelay(response.headers, Date.now()) });
    return response.status === 204 ? null : response.json();
  }
}

export function requestJson(url, options = {}) {
  return options.fetchImpl && options.fetchImpl !== fetch
    ? injectedRequest(url, options)
    : shared.request(url, options);
}
export function getJson(url, token, fetchImpl = fetch, refresh = accessToken, options = {}) {
  if (typeof refresh !== "function" && typeof refresh !== "boolean") throw new TypeError("refresh must be a callback or boolean");
  return requestJson(url, { ...options, ...(refresh === true ? { cacheMs: 0 } : {}),
    token, fetchImpl, refresh: typeof refresh === "function" ? refresh : accessToken });
}
export async function readAdoMetrics(directory = cacheRoot) {
  const scopes = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const reports = await Promise.all(scopes.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const metrics = await readJson(path.join(directory, entry.name, "metrics.json"));
    const control = await readJson(path.join(directory, entry.name, "control.json"));
    return metrics ? { ...metrics, scope: entry.name, notBefore: control?.notBefore || 0 } : null;
  }));
  return reports.filter(Boolean);
}
