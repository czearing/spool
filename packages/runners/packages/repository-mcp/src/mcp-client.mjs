import { spawn } from "node:child_process";
import readline from "node:readline";

export function requestMcp({ command, args, env }, method, params = {}, { onProgress, keepAlive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...env },
    });
    let settled = false;
    let stderr = "";
    const lines = readline.createInterface({ input: child.stdout });
    const closed = new Promise(resolve => child.once("close", resolve));
    let closing;
    const close = () => closing ||= (async () => {
      lines.close();
      if (!child.stdin.destroyed) child.stdin.end();
      const code = await closed;
      if (code !== 0) throw new Error(`MCP lifecycle exited ${code}: ${stderr}`);
    })();
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (keepAlive && !error) {
        resolve({ result, close, closed });
        return;
      }
      lines.close();
      child.stdin.end();
      if (error) reject(error);
      else resolve(result);
    };
    const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    child.on("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-64_000); });
    child.on("close", code => {
      if (!settled) finish(new Error(`MCP exited ${code} without a result: ${stderr}`));
    });
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.error) return finish(new Error(message.error.message));
        if (message.id === 1) {
          send({ method: "notifications/initialized" });
          send({ id: 2, method, params });
        } else if (message.id === 2) {
          finish(null, message.result);
        } else if (message.method === "notifications/progress") {
          onProgress?.(message.params);
        }
      } catch (error) { finish(error); }
    });
    send({
      id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "repository-mcp", version: "1.0.0" },
      },
    });
  });
}
