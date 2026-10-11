import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { randomUUID, timingSafeEqual } from "node:crypto";

const dist = process.env.SPOOL_MONITOR_DIST || path.resolve(import.meta.dirname, "..", "monitor", "dist");
const securityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

export function createMonitorClient(root) {
  let worker, snapshot, refreshError, sequence = 0;
  const pending = new Map();
  const readyWaiters = new Set();
  function settleReady() {
    for (const resolve of readyWaiters) resolve();
    readyWaiters.clear();
  }
  function fail(error) {
    refreshError = error.message;
    settleReady();
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  }
  function start() {
    if (worker) return;
    worker = new Worker(new URL("./monitor-worker.mjs", import.meta.url), {
      workerData: { root }, execArgv: process.execArgv.filter(argument => !argument.startsWith("--input-type")),
    });
    worker.unref();
    worker.on("message", message => {
      if (message.snapshot) { snapshot = message.snapshot; refreshError = null; }
      if (message.refreshError) refreshError = message.refreshError;
      if (message.snapshot || message.refreshError) settleReady();
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(Object.assign(new Error(message.error), { code: message.code }));
      else request.resolve(message.data);
    });
    worker.on("error", error => { console.error(`Monitor worker failed: ${error.stack || error}`); fail(error); });
    worker.on("exit", code => {
      worker = null;
      fail(new Error(refreshError || `Monitor data worker exited (${code}); next request will reconnect`));
    });
  }
  start();
  return {
    ready() {
      return snapshot || refreshError ? Promise.resolve() : new Promise(resolve => readyWaiters.add(resolve));
    },
    snapshot() {
      start();
      if (!snapshot) throw Object.assign(new Error(refreshError || "Monitoring is starting; retrying shortly"), { code: 503 });
      const stale = Date.now() - Date.parse(snapshot.checkedAt) > 20000;
      return { ...snapshot, error: refreshError || (stale ? "Monitoring data is stale; waiting for a fresh process check" : null) };
    },
    conversation(task, before) {
      return this.request({ task, before });
    },
    request(payload) {
      start();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error("Conversation read timed out"), { code: 503 }));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, ...payload });
      });
    },
    async close() {
      fail(new Error("Monitor closed"));
      if (worker) await worker.terminate();
    },
  };
}

export function createMonitorHandler(client, { assetRoot = dist } = {}) {
  const assets = new Map();
  const legacyPages = new Map([
    ["/SPOOL", "/"],
    ["/SPOOL/dashboard", "/"],
    ["/SPOOL/agents/all", "/agents"],
    ["/SPOOL/issues/all", "/tasks"],
  ]);
  const token = randomUUID();
  return async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const legacyApi = ["/api/agents", "/api/agent-log"].includes(url.pathname);
    const api = url.pathname.startsWith("/api/monitor/") || legacyApi;
    const page = /^\/(?:$|dashboard\/?$|monitor(?:\/.*)?$|spool(?:\/.*)?$|kanban(?:\/.*)?$|agents(?:\/[^/]+)?\/?$|tasks(?:\/[^/]+)?\/?$|issues\/[^/]+\/?$|projects(?:\/[^/]+)*\/?$|settings\/?$|system\/?$|unsupported(?:\/.*)?$)/.test(url.pathname);
    const asset = url.pathname.startsWith("/assets/");
    const alias = ["/job", "/history"].includes(url.pathname);
    const legacyPage = legacyPages.get(url.pathname.replace(/\/$/, ""));
    const messageRoute = /^\/api\/monitor\/tasks\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,179})\/message$/.exec(url.pathname);
    if (!api && !page && !asset && !alias && !legacyPage) return false;
    const send = (code, body, type = "application/json", extra = {}) => {
      response.writeHead(code, { ...securityHeaders, "cache-control": "no-store",
        "content-type": `${type}; charset=utf-8`, ...extra });
      response.end(request.method === "HEAD" ? "" : body);
    };
    if (!["GET", "HEAD"].includes(request.method) && !(request.method === "POST" && (url.pathname === "/api/monitor/control" || messageRoute))) {
      send(405, "Method not supported", "text/plain", { allow: "GET, HEAD" }); return true;
    }
    try {
      if (legacyPage) {
        send(302, "", "text/plain", { location: legacyPage });
      } else if ((url.pathname === "/api/monitor/control" || messageRoute) && request.method === "POST") {
        const headers = request.headers || {}, host = headers.host || "";
        const supplied = Buffer.from(headers["x-spool-token"] || "");
        if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || headers.origin !== `http://${host}` ||
            !/^application\/json(?:;|$)/i.test(headers["content-type"] || "") ||
            supplied.length !== Buffer.byteLength(token) || !timingSafeEqual(supplied, Buffer.from(token))) {
          send(403, "Same-origin JSON request with the current control token is required", "text/plain");
        } else if (typeof request.body !== "string" || Buffer.byteLength(request.body) > 150 * 1024) {
          send(413, "Control request is too large", "text/plain");
        } else {
          let input;
          try { input = JSON.parse(request.body); }
          catch { send(400, "Invalid JSON", "text/plain"); return true; }
          if (messageRoute) {
            if (!input || typeof input !== "object" || Array.isArray(input) ||
                Object.keys(input).some(key => !["id", "message"].includes(key))) {
              send(400, "Expected a message and command identity", "text/plain"); return true;
            }
            input = { id: input.id, kind: "message", taskId: messageRoute[1], message: input.message };
          }
          const result = await client.request({ operation: "submit", input });
          send(202, JSON.stringify(result));
        }
      } else if (url.pathname === "/api/monitor/control-options") {
        const result = await client.request({ operation: "options" });
        send(200, JSON.stringify({ ...result, token }));
      } else if (url.pathname === "/api/monitor/control-result") {
        const result = await client.request({ operation: "receipt", command: url.searchParams.get("id") });
        send(result ? 200 : 404, result ? JSON.stringify(result) : "Command not found", result ? "application/json" : "text/plain");
      } else if (alias) {
        const id = url.searchParams.get("id")?.replace(/^spool:/, "");
        send(302, "", "text/plain", { location: id ? `/tasks/${encodeURIComponent(id)}` : "/tasks" });
      } else if (["/api/monitor/snapshot", "/api/agents"].includes(url.pathname)) {
        const snapshot = client.snapshot();
        send(200, JSON.stringify(legacyApi ? { agents: snapshot.agents.map(agent => ({
          ...agent, tasks: snapshot.tasks.filter(task => task.agent === agent.name),
        })) } : snapshot));
      } else if (["/api/monitor/task", "/api/agent-log"].includes(url.pathname)) {
        const id = url.searchParams.get(legacyApi ? "task" : "id");
        const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : null;
        if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id) ||
            (before !== null && (!Number.isSafeInteger(before) || before < 0))) {
          send(400, "Invalid task or log position", "text/plain");
        } else {
          let result = await client.conversation(id, before);
          if (legacyApi && result) {
            const messages = result.entries.map(entry => ({
              kind: entry.kind.startsWith("tool") ? "tool" : ["assistant", "user"].includes(entry.kind) ? entry.kind : "log",
              title: entry.kind === "tool_call" ? `Tool: ${entry.name}` : entry.kind === "tool_result" ? entry.isError ? "Tool error" : "Tool result"
                : entry.kind === "user" ? "Instructions" : entry.kind === "assistant" ? "Agent" : "Log",
              at: entry.ts, text: entry.text ?? entry.content ?? entry.input,
            }));
            messages.push(...result.notes.map(note => ({ kind: "note", title: `Task note: ${note.author}`, at: note.at, text: note.text })));
            result = { ...result, messages };
          }
          send(result ? 200 : 404, result ? JSON.stringify(result) : "Task not found", result ? "application/json" : "text/plain");
        }
      } else if (api) send(404, "Unknown monitoring endpoint", "text/plain");
      else {
        const name = asset ? url.pathname.slice(8) : "index.html";
        if (!/^[a-zA-Z0-9_.-]+\.(?:html|js|css)$/.test(name)) {
          send(404, "Asset not found", "text/plain");
        } else {
          const file = path.join(assetRoot, ...(asset ? ["assets", name] : [name]));
          if (!existsSync(file)) {
            send(asset ? 404 : 503, asset ? "Asset not found" : "Monitoring UI is not built. Run npm ci and npm run build in monitor.", "text/plain");
          } else {
            if (!assets.has(file)) assets.set(file, readFileSync(file, "utf8"));
            const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html";
            send(200, assets.get(file), type, asset ? { "cache-control": "public, max-age=31536000, immutable" } : {});
          }
        }
      }
    } catch (error) {
      send(Number.isInteger(error.code) ? error.code : error instanceof RangeError ? 400 : 500, error.message, "text/plain");
    }
    return true;
  };
}
