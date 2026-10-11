import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { clearPidRecord, runtimePaths } from "./supervisor.js";
import { readRunnerJson, runnerError, writeRunnerJson } from "./runner-files.js";

export function runnerEndpoint(entry) {
  const directory = realpathSync.native(path.dirname(entry));
  const identity = process.platform === "win32" ? directory.toLowerCase() : directory;
  const name = `bohemia-runner-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\${name}`;
  if (process.platform === "linux") return `\0${name}`;
  return path.join(tmpdir(), `${name}.sock`);
}

export async function requestRunnerStop(entry, pid) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(runnerEndpoint(entry));
    let text = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy(new Error("Runner stop request timed out")));
    socket.once("error", reject);
    socket.once("connect", () => socket.end(`${JSON.stringify({ action: "stop", pid })}\n`));
    socket.on("data", chunk => { text += chunk; });
    socket.once("end", () => {
      try {
        const reply = JSON.parse(text);
        if (reply.pid !== pid || !reply.stopping) throw new Error("Runner did not confirm a graceful stop");
        resolve(reply);
      } catch (error) { reject(error); }
    });
  });
}

export async function runManagedRunner(entryUrl, initialize) {
  const entry = entryUrl instanceof URL || String(entryUrl).startsWith("file:")
    ? fileURLToPath(entryUrl) : path.resolve(entryUrl);
  const directory = path.dirname(entry);
  const paths = runtimePaths({ directory });
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  let wakeController, wakePending = false;
  const wake = () => { wakePending = true; wakeController?.abort(); };
  let status;
  let stopping = false;
  const stop = () => { stopping = true; controller.abort(); };
  const lock = net.createServer({ allowHalfOpen: true }, socket => {
    let text = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", error => {
      // A health client can disconnect while a synchronous scan holds the event loop.
      if (!["EPIPE", "ECONNRESET"].includes(error.code)) {
        console.error(`Runner control connection failed: ${error.message}`);
      }
    });
    socket.on("data", chunk => {
      text += chunk;
      if (text.length > 1024) { socket.destroy(); return; }
      if (!text.includes("\n")) return;
      try {
        const request = JSON.parse(text);
        if (request.action === "stop" && request.pid === process.pid) stop();
        socket.end(JSON.stringify({ pid: process.pid, instanceId, stopping }));
      } catch (error) {
        socket.end(JSON.stringify({ error: error.message }));
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      lock.once("error", reject);
      lock.listen(runnerEndpoint(entry), resolve);
    });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    console.error(`Runner already owns ${directory}; duplicate launch refused.`);
    return;
  }
  const publish = update => {
    const error = runnerError(update);
    const now = new Date().toISOString();
    status = {
      ...update,
      pid: process.pid, entry, instanceId, startedAt,
      lastAttempt: now,
      lastScan: error ? status?.lastScan ?? null : now,
      lastError: error,
      phase: error ? "degraded" : "ready",
    };
    delete status.error;
    writeRunnerJson(paths.statusFile, status);
    return status;
  };
  const fail = (error, extra = {}) => publish({
    ...status, ...extra, lastError: String(error?.message || error),
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
  try {
    // Previous observations remain visible, but cannot qualify this instance as ready.
    status = {
      ...readRunnerJson(paths.statusFile),
      pid: process.pid, entry, instanceId, startedAt,
      lastScan: null, lastAttempt: null, lastError: null, phase: "starting",
    };
    delete status.error;
    delete status.blocked;
    delete status.staleSince;
    writeRunnerJson(paths.pidFile, { pid: process.pid, entry, instanceId, startedAt });
    writeRunnerJson(paths.statusFile, status);
    await initialize({
      directory, runtime: paths.runtime, publish, fail, stop, wake,
      get status() { return status; },
      observe(update) {
        status = { ...status, ...update };
        writeRunnerJson(paths.statusFile, status);
      },
      async poll({ scan, onError, intervalMs, jitterMs = 0, once = false }) {
        if (!Number.isFinite(intervalMs) || intervalMs <= 0 ||
            !Number.isFinite(jitterMs) || jitterMs < 0) throw new Error("Invalid runner poll interval");
        while (!stopping) {
          let waitMs = intervalMs;
          status = { ...status, phase: "scanning", preparation: null, pollSeconds: intervalMs / 1000 };
          writeRunnerJson(paths.statusFile, status);
          try {
            const update = await scan();
            if (update) publish({ pollSeconds: intervalMs / 1000, ...update });
            if (status.phase === "scanning") throw new Error("Runner scan did not publish an outcome");
          } catch (error) {
            console.error(`Runner scan failed: ${error.stack || error}`);
            waitMs = Math.max(waitMs, Number(error.retryAfterMs) || 0);
            fail(error, { nextScan: new Date(Date.now() + waitMs).toISOString() });
            if (onError) await onError(error);
          }
          if (once || stopping) break;
          if (wakePending) { wakePending = false; continue; }
          wakeController = new AbortController();
          try {
            await delay(waitMs + Math.random() * jitterMs, undefined, { signal: AbortSignal.any([controller.signal, wakeController.signal]) });
          } catch (error) {
            if (error.name !== "AbortError" || !stopping && !wakePending) throw error;
          } finally { wakeController = undefined; wakePending = false; }
        }
      },
    });
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
    try {
      if (readRunnerJson(paths.pidFile)?.instanceId === instanceId) {
        if (status) writeRunnerJson(paths.statusFile, { ...status, phase: "stopped" });
        clearPidRecord(paths.pidFile);
      }
    } finally {
      await new Promise((resolve, reject) => lock.close(error => error ? reject(error) : resolve()));
    }
  }
}
