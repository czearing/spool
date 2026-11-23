import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export function runnerEngine() {
  if (process.env.SPOOL_RUNNER_ENGINE) return process.env.SPOOL_RUNNER_ENGINE;
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const relative of [`../../spool-engine${suffix}`, `../../../target/debug/spool${suffix}`,
    `../../../target/release/spool${suffix}`]) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(file)) return file;
  }
  throw new Error("The application Rust runner engine is missing. Build the Spool engine before starting runners.");
}

export function nativeSupervisor({ onError = () => {}, running = new Map() } = {}) {
  const child = spawn(runnerEngine(), ["runner-supervisor"], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let stopping = false, requestedStop = false, request = 0, readyResolve, readyReject, closeResolve, closeReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const closed = new Promise((resolve, reject) => { closeResolve = resolve; closeReject = reject; });
  const report = error => { console.error("Rust runner supervision failed:", error); onError(error); };
  ready.catch(report);
  closed.catch(report);
  child.stderr.on("data", data => console.error(data.toString().trimEnd()));
  child.stdin.on("error", report);
  child.once("error", error => { readyReject(error); closeReject(error); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const message = JSON.parse(line);
      if (message.type === "error") { report(new Error(message.error)); return; }
      if (message.type === "applied") {
        const operation = pending.get(message.request);
        if (!operation) throw new Error("Unknown Rust runner engine acknowledgement.");
        pending.delete(message.request);
        if (message.error) operation.reject(new Error(message.error));
        else operation.resolve();
        return;
      }
      if (!["ready", "state", "stopped"].includes(message.type) || !Array.isArray(message.workers))
        throw new Error("Invalid Rust runner engine response.");
      running.clear();
      for (const worker of message.workers) running.set(worker.id, {
        key: worker.key, draining: worker.draining, child: { pid: worker.pid },
      });
      if (message.type === "ready") readyResolve();
      else if (message.type === "state") {
        if (message.error) report(new Error(message.error));
        else onError(null);
      }
    } catch (error) {
      report(error);
      if (!stopping) { stopping = true; child.stdin.end(); }
    }
  });
  child.once("close", (code, signal) => {
    stopping = true; lines.close(); running.clear();
    const error = new Error(`Rust runner engine exited (${code ?? signal}).`);
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
    readyReject(error);
    if (code === 0 && requestedStop) closeResolve();
    else closeReject(error);
  });
  return {
    ready, running, closed, pid: child.pid,
    reconcile(workers) {
      if (stopping) throw new Error("Rust runner engine is stopping.");
      const id = ++request;
      const command = JSON.stringify({ type: "reconcile", request: id, workers }) + "\n";
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(command, error => {
          if (!error) return;
          pending.delete(id); reject(error);
        });
      });
    },
    stop() {
      if (!stopping) {
        requestedStop = true; stopping = true;
        child.stdin.end(JSON.stringify({ type: "stop" }) + "\n");
      }
      return closed;
    },
  };
}
