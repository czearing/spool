import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";

export function startBackendFixture(root) {
  const script = process.env.SPOOL_TEST_BACKEND || path.resolve(import.meta.dirname, "..", "src-tauri", "resources", "backend.mjs");
  const child = spawn(process.execPath, [script], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const service = spawn(process.execPath, [script, "--runner-service"],
    { cwd: root, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  service.stderr.on("data", chunk => { stderr += chunk; });
  service.on("error", error => { stderr += error.message; });
  const serviceExit = new Promise(resolve => service.once("close", resolve));
  const childExit = new Promise(resolve => child.once("close", resolve));
  const waiting = new Map();
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Backend exited ${code}: ${stderr}`)));
    createInterface({ input: child.stdout }).on("line", line => {
      const frame = JSON.parse(line);
      if (frame.id === "ready") return resolve();
      waiting.get(frame.id)?.(frame);
    });
  });
  const request = (url, method = "GET", body) => new Promise((resolve, reject) => {
    const id = randomUUID(), frames = [];
    const timeout = setTimeout(() => reject(new Error(`Request timed out: ${stderr}`)), 10000);
    waiting.set(id, frame => {
      frames.push(frame);
      if (frame.type === "end" || frame.type === "error") {
        clearTimeout(timeout); waiting.delete(id);
        const content = frames.filter(value => value.type === "chunk").map(value => Buffer.from(value.body, "base64").toString()).join("");
        resolve({ status: frames[0].status, body: content ? JSON.parse(content) : null, error: frame.error });
      }
    });
    child.stdin.write(JSON.stringify({ id, url, method, headers: [["content-type", "application/json"]], body }) + "\n");
  });
  return { child, ready, waiting, request, async stop() {
    if (!service.stdin.destroyed) service.stdin.end("shutdown\n");
    await serviceExit;
    child.stdin.end();
    await childExit;
    assert.equal(service.exitCode, 0, stderr);
    assert.equal(child.exitCode, 0, stderr);
  } };
}
