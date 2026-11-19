import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const write = message => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const pending = new Set();
const lifecycles = new Map();
let stopReading;
const stopped = new Promise(resolve => { stopReading = resolve; });

async function handle(request) {
  if (request.id === undefined) return;
  if (request.method === "initialize") return write({
    id: request.id, result: {
      protocolVersion: "2024-11-05", capabilities: { tools: {} },
      serverInfo: { name: "repository-mcp", version: "1.0.0" },
    },
  });
  if (request.method === "ping") return write({ id: request.id, result: {} });
  if (!["tools/list", "tools/call"].includes(request.method))
    return write({ id: request.id, error: { code: -32601, message: `Unknown method: ${request.method}` } });
  const progressToken = request.params?._meta?.progressToken;
  const started = Date.now();
  const timer = progressToken === undefined || request.params?.arguments?.repo === "bohemia" ? null : setInterval(() => write({
    method: "notifications/progress", params: {
      progressToken, progress: Math.floor((Date.now() - started) / 1000),
      message: `${request.params?.name || request.method} is still running; detailed command logs are retained in the checkout.`,
    },
  }), 15_000);
  try {
    const args = request.params?.arguments;
    const input = args?.input ?? args;
    const oneJs = args?.repo === "1js" || !args?.repo && Boolean(process.env.REPOSITORY_CODESPACE_SESSION);
    const lifecycle = request.params?.name === "repo_prepare" && oneJs &&
      input?.reviewPullRequestId !== undefined;
    const child = spawn(process.execPath, [worker, ...(lifecycle ? ["--codespace-lifecycle"] : [])],
      { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    let result;
    let protocolError;
    let received, receiveError;
    const response = new Promise((resolve, reject) => { received = resolve; receiveError = reject; });
    const output = readline.createInterface({ input: child.stdout });
    output.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.method === "notifications/progress") write(message);
        else if (message.id === request.id && !result) { result = message; received(message); }
        else throw new Error("Unexpected repository worker response");
      } catch (error) { protocolError = error; receiveError(error); }
    });
    const exit = new Promise((resolve, reject) => {
      child.on("error", error => { receiveError(error); reject(error); });
      child.stdin.on("error", error => { receiveError(error); reject(error); });
      child.on("close", code => {
        if (!result) receiveError(new Error(`Repository worker exited ${code} without a result`));
        if (lifecycle && result && !result.error && !result.result?.isError && code !== 0) {
          process.stderr.write(`Owned repository MCP lifecycle exited ${code}\n`);
          process.exitCode = 1;
          stopReading();
        }
        resolve(code);
      });
    });
    // Reviewer preparation retains its owned processes until MCP disconnects.
    if (lifecycle) {
      lifecycles.set(child, exit);
      child.stdin.write(`${JSON.stringify(request)}\n`);
      try { await response; }
      catch (error) { child.stdin.end(); await exit; throw error; }
      if (result.error || result.result?.isError) { child.stdin.end(); await exit; lifecycles.delete(child); }
      write(result);
      return;
    }
    void response.catch(() => {});
    child.stdin.end(JSON.stringify(request));
    const code = await exit;
    if (protocolError) throw protocolError;
    if (code !== 0 || !result) throw new Error(`Repository worker exited ${code} without a result`);
    write(result);
  } catch (error) {
    write({ id: request.id, error: { code: -32603, message: error.message } });
  } finally { clearInterval(timer); }
}

const lines = readline.createInterface({ input: process.stdin });
try {
  await Promise.race([stopped, (async () => {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        const operation = handle(request);
        pending.add(operation);
        void operation.finally(() => pending.delete(operation));
      } catch (error) {
        write({ id: null, error: { code: -32700, message: error.message } });
      }
    }
  })()]);
} finally {
  lines.close();
  await Promise.all(pending);
  for (const child of lifecycles.keys()) if (!child.stdin.destroyed) child.stdin.end();
  for (const exit of lifecycles.values()) {
    if (await exit !== 0) process.exitCode = 1;
  }
  process.stdin.destroy();
}
