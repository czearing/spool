import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { AgentError } from "./agents";
import { isAgentSettings } from "./agent-settings";
import { readOptionalJson } from "./spool-publish";

export async function assertAgentSettingsSupported(root: string) {
  const value = await readOptionalJson(join(root, "controls", "capabilities.json"));
  const valid = value && typeof value === "object" && "agentSettingsVersion" in value && value.agentSettingsVersion === 1 &&
    "updatedAt" in value && typeof value.updatedAt === "string";
  const age = valid && typeof value.updatedAt === "string" ? Date.now() - Date.parse(value.updatedAt) : NaN;
  if (!valid || !Number.isFinite(age) || age < 0 || age >= 15000) {
    throw new AgentError("Start an updated Spool daemon before creating agents or changing their settings.", 503);
  }
}
export async function callAgentTool(root: string, name: string, args: Record<string, unknown>) {
  const binary = process.env.SPOOL_AGENT_BINARY ?? resolve(process.cwd(), "..", "spool", "target", "release",
    process.platform === "win32" ? "spool.exe" : "spool");
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
