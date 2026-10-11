const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const { setTimeout: delay } = require("node:timers/promises");

(async () => {
  const root = process.env.SPOOL_TASK_FIXTURE;
  assert.ok(root && fs.existsSync(path.join(root, "fixture-only")), "Isolated fixture required");
  const context = JSON.parse(fs.readFileSync(process.env.BOHEMIA_CREATOR_CONTEXT, "utf8"));
  assert.ok(path.resolve(context.workspace).startsWith(path.resolve(root) + path.sep));
  const input = fs.readFileSync(0, "utf8");
  const session = process.argv[process.argv.findIndex(arg => arg === "--session-id" || arg === "--resume") + 1];
  const config = JSON.parse(process.argv[process.argv.indexOf("--additional-mcp-config") + 1]).mcpServers.spool;
  assert.equal(config.command, process.env.SPOOL_TASK_SPOOL_BINARY);
  fs.writeFileSync(path.join(root, `provider-${context.agent}.json`),
    JSON.stringify({ pid: process.pid, taskId: context.taskId, session, input, args: process.argv.slice(2) }));
  console.log(JSON.stringify({ type: "assistant.message", data: { content: `Fixture ${context.agent} started` } }));
  while (!fs.existsSync(path.join(root, `release-${context.agent}`))) await delay(50);
  const mcp = spawn(config.command, config.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(mcp, "exit"), lines = createInterface({ input: mcp.stdout });
  const waiting = new Map();
  let sequence = 0, diagnostics = "";
  mcp.stderr.on("data", bytes => { diagnostics += bytes; });
  lines.on("line", line => {
    const message = JSON.parse(line), waiter = waiting.get(message.id);
    if (!waiter) return;
    waiting.delete(message.id);
    if (message.error || message.result?.isError) waiter.reject(new Error(JSON.stringify(message)));
    else waiter.resolve(message.result);
  });
  mcp.on("exit", code => {
    for (const waiter of waiting.values()) waiter.reject(new Error(`MCP exited ${code}: ${diagnostics}`));
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    waiting.set(id, { resolve, reject });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "isolated-task-workflow-test", version: "1" } });
  await request("tools/call", { name: "spool_add_comment", arguments: { comment: `Verified fixture turn for ${context.agent}` } });
  await request("tools/call", { name: "spool_update_task_status", arguments: { status: "completed" } });
  mcp.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
  lines.close();
  const usage = process.argv[process.argv.indexOf("--usage-output-file") + 1];
  fs.writeFileSync(usage, JSON.stringify({ input_tokens: 10, output_tokens: 1, turns: 1 }));
  const override = path.join(root, "reported-session");
  const reportedSession = fs.existsSync(override) ? fs.readFileSync(override, "utf8") || undefined : session;
  console.log(JSON.stringify({ type: "result", sessionId: reportedSession, exitCode: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; });
