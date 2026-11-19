import fs from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

export function commandServer() {
  const { spawn } = require("node:child_process");
  const { createInterface } = require("node:readline");
  const send = value => process.stdout.write(JSON.stringify(value) + "\n");
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    const { id, command, input, shutdown } = JSON.parse(line);
    if (shutdown) {
      lines.close();
      process.stdin.destroy();
      return;
    }
    const child = spawn("bash", ["-ec", command], { stdio: ["pipe", "pipe", "pipe"] });
    for (const stream of ["stdout", "stderr"])
      child[stream].on("data", data => send({ id, stream, data: data.toString("base64") }));
    child.stdin.on("error", () => {});
    child.on("error", error => send({ id, error: error.message }));
    child.on("close", code => send({ id, code }));
    child.stdin.end(input === undefined ? undefined : Buffer.from(input, "base64"));
  });
  send({ ready: true });
}

export class CommandChannel {
  constructor(child, { onFailure = () => {}, startupTimeoutMs = 120000 } = {}) {
    this.child = child;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.connected = resolve;
      this.refused = reject;
    });
    this.ready.catch(() => {});
    this.startupTimer = setTimeout(() => {
      this.fail(new Error("SSH command channel startup timed out before any commands were sent"));
      child.kill();
    }, startupTimeoutMs);
    let stderr = "";
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-16000); });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", line => {
      let value;
      try { value = JSON.parse(line); }
      catch { this.fail(new Error("Invalid Codespace command-channel response")); return; }
      if (value.ready) { clearTimeout(this.startupTimer); this.connected(); return; }
      const request = this.pending.get(value.id);
      if (!request) return;
      if (value.stream) {
        const data = Buffer.from(value.data, "base64");
        request.log?.write(data);
        request.output = Buffer.concat([request.output, data]).subarray(-64000);
        if (value.stream === "stdout") {
          request.stdout.push(data);
          request.size += data.length;
          if (request.size > 16 * 1024 * 1024) {
            request.error ||= new Error("Command stdout exceeded 16 MiB; result cannot be verified");
            request.stdout = [];
          }
        }
      } else if (value.error) request.error = new Error(value.error);
      else if (Object.hasOwn(value, "code")) {
        this.pending.delete(value.id);
        const finish = () => {
          if (request.error) request.reject(request.error);
          else if (value.code !== 0) request.reject(new Error(
            `Remote command failed (${value.code})\n${request.output.toString("utf8")}`));
          else request.resolve({ stdout: Buffer.concat(request.stdout).toString("utf8"),
            output: request.output.toString("utf8"), logFile: request.logFile });
        };
        if (request.log) request.log.end(finish);
        else finish();
      }
    });
    child.stdin.on("error", error => this.fail(error));
    child.once("error", error => this.fail(error));
    this.closed = new Promise(resolve => child.once("close", code => {
      const error = new Error(`Codespace command channel closed (${code})${stderr ? `\n${stderr}` : ""}`);
      if (code !== 0) onFailure(this.failure || error);
      this.fail(error);
      resolve();
    }));
  }
  fail(error) {
    clearTimeout(this.startupTimer);
    this.failure ||= error;
    this.refused(this.failure);
    for (const request of this.pending.values()) {
      request.log?.end();
      request.reject(this.failure);
    }
    this.pending.clear();
  }
  async run(command, { input, logFile } = {}) {
    await this.ready;
    if (this.failure) throw this.failure;
    const id = randomUUID();
    const log = logFile ? fs.createWriteStream(logFile, { flags: "wx" }) : null;
    const result = new Promise((resolve, reject) => {
      const request = { resolve, reject, log, logFile, stdout: [], size: 0, output: Buffer.alloc(0) };
      log?.on("error", error => { request.error = error; });
      this.pending.set(id, request);
    });
    this.child.stdin.write(JSON.stringify({ id, command,
      ...(input === undefined ? {} : { input: Buffer.from(input).toString("base64") }) }) + "\n");
    return result;
  }
  async close() {
    if (!this.failure && !this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify({ shutdown: true }) + "\n");
    this.child.stdin.end();
    await this.closed;
    this.lines.close();
  }
}
