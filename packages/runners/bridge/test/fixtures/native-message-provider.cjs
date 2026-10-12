const fs = require("node:fs"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createInterface } = require("node:readline");
const root = process.env.SPOOL_NATIVE_MESSAGE_FIXTURE;
if (!root || !fs.existsSync(path.join(root, "native-message-fixture"))) throw Error("Not an isolated provider fixture");
const session = "native-message-fixture-session";
const args = process.argv.slice(2), model = args[args.indexOf("--model") + 1];
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const historyFile = path.join(root, "provider-history.json");
let history = [];
(async () => {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    fs.appendFileSync(path.join(root, "provider-protocol.jsonl"), JSON.stringify({ ...request, pid: process.pid }) + "\n");
    if (request.method === "initialize") {
      send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    } else if (["session/new", "session/load"].includes(request.method)) {
      if (request.method === "session/load") {
        if (request.params.sessionId !== session) throw Error("Wrong session requested");
        history = JSON.parse(fs.readFileSync(historyFile, "utf8"));
      }
      send({ id: request.id, result: { sessionId: session, models: { currentModelId: model } } });
    } else if (request.method === "session/prompt") {
      history.push(request.params.prompt);
      fs.writeFileSync(historyFile, JSON.stringify(history));
      send({ method: "session/update", params: { sessionId: session, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Received turn ${history.length}` },
      } } });
      const chat = request.params.prompt.some(message => message.text === "What did you change?");
      const binary = JSON.parse(args[args.indexOf("--additional-mcp-config") + 1]).mcpServers.spool.command;
      const completion = spawnSync(binary, ["--root", root, "mcp",
        "--agent", "pr-updater", "--task", "original"], {
        input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: chat ? "spool_add_comment" : "spool_update_task_status",
            arguments: chat ? { comment: "Answered without declaring new workflow completion." } : { status: "completed" } } }) + "\n",
        encoding: "utf8", windowsHide: true,
      });
      if (completion.status !== 0 || JSON.parse(completion.stdout).result.isError) throw Error("Native MCP operation failed");
      send({ id: request.id, result: { stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } } });
    } else if (request.id !== undefined) send({ id: request.id, result: {} });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
