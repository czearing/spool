import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { AgentError } from "./agents";
import { isAgentSettings } from "./agent-settings";
export async function callAgentTool(root: string, name: string, args: Record<string, unknown>) {
  const binary = process.env.SPOOL_AGENT_BINARY ?? fileURLToPath(new URL(
    `../../../target/release/spool${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
  const result = await new Promise<unknown>((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ binary, ["--root", root, "mcp"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false, errors = "";
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); child.stdin.end();
      if (error) reject(error); else resolve(value);
    };
    const timeout = setTimeout(() => finish(new AgentError("Spool did not confirm the agent change. Reload before retrying.", 503)), 15000);
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.stderr.on("data", (data) => { errors = (errors + data).slice(-4000); });
    child.on("close", () => finish(new AgentError(`Spool exited without a response. ${errors}`, 503)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.error) return finish(new AgentError(message.error.message, 503));
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
        } else if (message.id === 2) {
          const value = message.result;
          if (value?.isError) return finish(new AgentError(value.content?.map((row: { text?: string }) => row.text ?? "").join("\n")
            || "Spool rejected the agent request.", value.structuredContent?.status ?? 400));
          finish(undefined, value?.structuredContent);
        }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05",
      capabilities: {}, clientInfo: { name: "spool-web-ui", version: "1" } } });
  });
  if (!isAgentSettings(result)) throw new AgentError("Spool returned invalid agent settings.", 503);
  return result;
}
