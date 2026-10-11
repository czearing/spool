const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { randomUUID } = require("node:crypto");
const root = process.env.SPOOL_CHAT_FIXTURE;
if (!root || !fs.existsSync(path.join(root, "fixture-only"))) throw new Error("Explicit isolated fixture required");
const model = process.argv[process.argv.indexOf("--model") + 1];
const configIndex = process.argv.indexOf("--additional-mcp-config");
if (configIndex < 0) throw new Error("Task tools must be registered through host MCP configuration");
const spool = JSON.parse(process.argv[configIndex + 1]).mcpServers?.spool;
if (!spool || spool.type !== "local" || !spool.args.includes("--task")) throw new Error("Missing task-scoped Spool MCP server");
let session, taskId, pending, turn = 0;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = value => send({ method: "session/update", params: { sessionId: session, update: value } });
function finish(stopReason = "end_turn") {
  if (!pending) return;
  const id = pending; pending = null;
  update({ sessionUpdate: "tool_call_update", toolCallId: `inspect-${turn}`, status: "completed", rawOutput: "Verified fixture output" });
  update({ sessionUpdate: "plan", entries: [{ content: "Inspect task", status: "completed", priority: "high" }] });
  send({ id, result: { stopReason, usage: { input_tokens: 10, output_tokens: 4 } } });
}
const watch = setInterval(() => {
  if (pending && turn === 1 && fs.existsSync(path.join(root, `release-${taskId}`))) finish();
}, 30);
watch.unref();
readline.createInterface({ input: process.stdin }).on("line", line => {
  const value = JSON.parse(line);
  switch (value.method) {
    case "initialize": return send({ id: value.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    case "session/new":
      if (value.params.mcpServers?.length) throw new Error("Local MCP commands are not accepted from ACP clients");
      session = randomUUID();
      // Native setup may create the session before it has a task-scoped creator context.
      taskId = process.env.BOHEMIA_CREATOR_CONTEXT ? path.basename(process.env.BOHEMIA_CREATOR_CONTEXT, ".json") : null;
      fs.writeFileSync(path.join(root, `session-${session}.json`), "{}");
      return send({ id: value.id, result: { sessionId: session, models: { currentModelId: model } } });
    case "session/load": {
      if (value.params.mcpServers?.length) throw new Error("Local MCP commands are not accepted from ACP clients");
      session = value.params.sessionId;
      if (!fs.existsSync(path.join(root, `session-${session}.json`))) throw new Error("Session identity was not preserved");
      const context = JSON.parse(fs.readFileSync(process.env.BOHEMIA_CREATOR_CONTEXT, "utf8"));
      if (context.sessionId !== session || process.env.COPILOT_SESSION_ID !== session) throw new Error("Creator identity mismatch");
      taskId = context.taskId;
      return send({ id: value.id, result: { models: { currentModelId: model } } });
    }
    case "session/set_config_option": return send({ id: value.id, result: {} });
    case "session/prompt":
      if (pending) throw new Error("Overlapping turns");
      {
        const context = JSON.parse(fs.readFileSync(process.env.BOHEMIA_CREATOR_CONTEXT, "utf8"));
        if (context.sessionId !== session || context.providerToken !== process.env.SPOOL_PROVIDER_TOKEN ||
            (process.env.COPILOT_SESSION_ID && process.env.COPILOT_SESSION_ID !== session)) throw new Error("Creator identity mismatch");
      }
      pending = value.id; turn++;
      fs.appendFileSync(path.join(root, `prompts-${taskId}.jsonl`), JSON.stringify(value.params.prompt) + "\n");
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Streaming turn ${turn}: ` } });
      setTimeout(() => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "inspecting now" } }), 60);
      setTimeout(() => {
        update({ sessionUpdate: "tool_call", toolCallId: `inspect-${turn}`, title: "Inspect workspace", status: "in_progress", rawInput: { task: taskId } });
        update({ sessionUpdate: "plan", entries: [{ content: "Inspect task", status: "in_progress", priority: "high" }] });
      }, 120);
      if (turn > 1) setTimeout(() => finish(), 200);
      return;
    case "session/cancel":
      fs.writeFileSync(path.join(root, `cancelled-${taskId}`), "graceful");
      return finish("cancelled");
    default: throw new Error(`Unexpected ACP method: ${value.method}`);
  }
});
