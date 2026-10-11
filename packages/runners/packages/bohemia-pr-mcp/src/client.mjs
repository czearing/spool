import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PREPARATION_BLOCKED } from "./resume-state.mjs";

export function callBohemia(name, args, options = {}) {
  return new Promise((resolve, reject) => {
    const runtime = options.runtime || process.env.BOHEMIA_MCP_RUNTIME || process.execPath;
    const child = (options.spawn || spawn)(runtime,
      [fileURLToPath(new URL("./index.ts", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...options.env } });
    let settled = false;
    let errorOutput = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      child.stdin.end();
      if (error) reject(error); else resolve(value);
    };
    child.stderr.on("data", data => { errorOutput = (errorOutput + data).slice(-8000); });
    child.on("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    child.on("close", code => { if (!settled) finish(new Error(`Bohemia MCP exited ${code} without a result: ${errorOutput}`)); });
    const lines = readline.createInterface({ input: child.stdout });
    const send = value => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.error) return finish(new Error(message.error.message));
        if (message.id === 1) {
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/call", params: { name, arguments: args, _meta: { progressToken: 2 } } });
        } else if (message.id === 2) {
          const result = message.result;
          if (result?.isError) {
            const error = new Error(result.content?.map(x => x.text || "").join("\n") || "Bohemia operation failed");
            if (result.structuredContent?.code === PREPARATION_BLOCKED) {
              error.code = PREPARATION_BLOCKED;
              error.reasonCode = result.structuredContent.reasonCode;
            }
            return finish(error);
          }
          if (name === "bohemia_pr") return finish(null, result);
          const value = result?.structuredContent;
          if (!value?.ok || !value.ready || !value.repoRoot || !value.commit) return finish(new Error("Bohemia did not confirm a prepared checkout"));
          finish(null, value);
        } else if (message.method === "notifications/progress") options.onProgress?.(message.params);
      } catch (error) { finish(error); }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "paperclip-runner", version: "1" } } });
  });
}
