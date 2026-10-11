#!/usr/bin/env node
import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
/// The transport, and deliberately nothing else.
///
/// This process outlives the code it was started with: a Copilot session spawns it once and keeps
/// it for hours. So it holds no rule, no schema and no check. Every request that could depend on
/// them is answered by a process started for that request, in worker.ts, which means an edit to
/// the rules is in force everywhere the moment it is saved rather than whenever agents happen to
/// restart. Keep this file free of anything that could need changing.

type Request = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown>; _meta?: { progressToken?: string | number } };
};

const WORKER = fileURLToPath(new URL("./worker.ts", import.meta.url));

function write(message: object) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const reply = (id: string | number, result: object) => ({ jsonrpc: "2.0" as const, id, result });

const error = (id: string | number, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message },
});

/// The child inherits stderr so a gate that streams progress still reaches the host's log, and it
/// is never given a deadline here: the checks take minutes by design and a timeout would turn a
/// slow pass into a spurious failure.
async function inFreshProcess(request: Request): Promise<object> {
  const child = spawn(process.execPath, [WORKER], {
    stdio: ["pipe", "pipe", "inherit"], windowsHide: true, env: process.env,
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve); child.stdin.on("error", reject);
  });
  child.stdin.write(JSON.stringify(request));
  child.stdin.end();
  const [out, code] = await Promise.all([text(child.stdout), exit]);
  if (code !== 0 || !out.trim()) {
    throw new Error(`worker exited ${code}${out.trim() ? `: ${out.trim().slice(0, 400)}` : ""}`);
  }
  return JSON.parse(out);
}

/// The checks take minutes, and a client that hears nothing gives up: a call was lost to
/// "MCP error -32001: Request timed out" while the gate kept running server-side, and the agent
/// concluded the tool was broken. The specification's answer is a progress notification, which
/// tells the client work is still happening and resets its timer. Installer-owned progress
/// provides cache counters without sending package output or credentials through the protocol.
function progressReporter(request: Request): () => void {
  const token = request.params?._meta?.progressToken;
  if (token === undefined) return () => {};
  const started = Date.now();
  let reading = false;
  let stopped = false;
  let detail = "";
  const repoRoot = request.params?.arguments?.repoRoot;
  async function refreshDetail() {
    if (reading || stopped || typeof repoRoot !== "string") return;
    reading = true;
    try {
      const update = await inFreshProcess({
        jsonrpc: "2.0", method: "internal/install-progress",
        params: { arguments: { repoRoot, notBefore: started } },
      });
      if ("detail" in update && typeof update.detail === "string") detail = update.detail;
    } catch (caught) {
      console.error(`[bohemia-pr] Cannot read install progress: ${caught instanceof Error ? caught.message : caught}`);
      detail = "; dependency-install progress unavailable (see server log)";
    } finally {
      reading = false;
    }
  }
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    write({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: seconds,
        message: `${request.params?.name || request.method} is still running (${seconds}s)${detail}`,
      },
    });
    void refreshDetail();
  }, 15_000);
  return () => { stopped = true; clearInterval(timer); };
}

async function handle(request: Request) {
  if (request.method === "initialize") {
    if (request.id === undefined) return;
    return write(
      reply(request.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bohemia-pr", version: "1.0.0" },
      }),
    );
  }
  if (request.method === "ping") {
    if (request.id !== undefined) write(reply(request.id, {}));
    return;
  }
  if (request.method === "tools/list" || request.method === "tools/call") {
    if (request.id === undefined) return;
    const stopReporting = progressReporter(request);
    try {
      write(await inFreshProcess(request));
    } catch (caught) {
      write(error(request.id, -32603, caught instanceof Error ? caught.message : String(caught)));
    } finally {
      stopReporting();
    }
    return;
  }
  if (!request.method.startsWith("notifications/") && request.id !== undefined) {
    write(error(request.id, -32601, `unknown method: ${request.method}`));
  }
}

let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of process.stdin) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        void handle(JSON.parse(line) as Request).catch((caught) => {
          console.error(`[bohemia-pr] ${caught instanceof Error ? caught.message : caught}`);
        });
      } catch (caught) {
        console.error(`[bohemia-pr] ${caught instanceof Error ? caught.message : caught}`);
      }
    }
    newline = buffer.indexOf("\n");
  }
}

// Stdin ended, so the host is gone.
process.exit(0);
