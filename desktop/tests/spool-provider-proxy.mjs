import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.env.SPOOL_PROBE_ROOT, trace = join(root, "protocol.jsonl");
const args = process.argv.slice(2);
const record = (direction, value) => appendFileSync(trace, JSON.stringify({ pid: process.pid, direction, ...value }) + "\n");
let servers = [];
try { servers = Object.keys(JSON.parse(readFileSync(join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "mcp-config.json"), "utf8")).mcpServers || {}); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const child = spawn(process.execPath, [process.env.SPOOL_REAL_COPILOT, ...args,
  "--no-custom-instructions", "--disable-builtin-mcps", "--no-auto-update", "--no-remote",
  ...servers.flatMap((name) => ["--disable-mcp-server", name]),
  "--available-tools", "__isolated_context_probe_no_tools__"], {
  env: { ...process.env, PATH: process.env.SPOOL_REAL_PATH, COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "" },
  cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
});
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
const input = createInterface({ input: process.stdin });
input.on("line", (line) => { record("request", JSON.parse(line)); child.stdin.write(line + "\n"); });
input.on("close", () => child.stdin.end());
createInterface({ input: child.stdout }).on("line", (line) => {
  const value = JSON.parse(line);
  record("response", value);
  if (value.method === "session/request_permission") {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { outcome: { outcome: "cancelled" } } }) + "\n");
  } else process.stdout.write(line + "\n");
});
child.on("exit", (code) => { process.exitCode = code ?? 1; input.close(); });
