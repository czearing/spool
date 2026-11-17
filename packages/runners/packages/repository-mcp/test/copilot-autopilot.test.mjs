import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { nativeCopilotCommand, withNativeInstructions } from "../src/codespaces/copilot.mjs";

test("Autopilot remote startup streams the adapter without changing ordinary ACP sessions", () => {
  assert.equal(nativeCopilotCommand(["--model", "fixture"]), 'copilot --acp --stdio \'--model\' \'fixture\' --additional-mcp-config "$MCP_CONFIG"');
  const shell = process.platform === "win32" ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : "sh";
  const source = fs.readFileSync(new URL("../src/copilot-autopilot.mjs", import.meta.url), "utf8") +
    "\nawait serveAutopilot(process.argv.slice(2));";
  const output = execFileSync(shell, ["-c", `MCP_CONFIG='{}'; ${withNativeInstructions(nativeCopilotCommand(["--model", "fixture"], true))}`], {
    input: "\n" + Buffer.from(source).toString("base64") + '\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n', encoding: "utf8",
  });
  assert.equal(JSON.parse(output).result.agentInfo.name, "spool-copilot-autopilot");
});

test("Autopilot remote instructions remain separate and their temporary directory is cleaned", () => {
  const shell = process.platform === "win32" ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : "sh";
  const role = "# Assigned role\nPreserve exact multiline instructions.\n";
  const command = 'cat "$SPOOL_AGENT_ROLE_DIRECTORY/role.instructions.md"; printf "\\n%s" "$SPOOL_AGENT_ROLE_DIRECTORY"';
  const output = execFileSync(shell, ["-c", withNativeInstructions(command)], {
    input: Buffer.from(role).toString("base64") + "\n\n", encoding: "utf8",
  });
  assert.equal(output.slice(0, role.length), role);
  const directory = output.slice(role.length + 1);
  assert.ok(directory);
  assert.equal(execFileSync(shell, ["-c", `test ! -e '${directory}' && printf cleaned`], { encoding: "utf8" }), "cleaned");
  assert.equal(execFileSync(shell, ["-c", withNativeInstructions("printf unchanged")], { input: "\n\n", encoding: "utf8" }), "unchanged");
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spool-autopilot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, "copilot.cjs");
  fs.writeFileSync(cli, `
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), resumed = args.includes("--resume");
const id = args[args.indexOf(resumed ? "--resume" : "--session-id") + 1];
if (!args.includes("--autopilot") || !args.includes("--output-format")) throw Error("Missing native prompt-mode options");
const directory = path.join(process.env.COPILOT_HOME, "session-state", id);
if (resumed && !fs.existsSync(path.join(directory, "events.jsonl"))) throw Error("Session was not restored");
let input = "";
process.stdin.setEncoding("utf8").on("data", data => input += data).on("end", () => {
  if (!input.startsWith("/autopilot ")) throw Error("Missing slash objective");
  fs.mkdirSync(directory, { recursive: true });
  const objective = input.slice("/autopilot ".length);
  fs.writeFileSync(path.join(directory, "autopilot-objective.json"),
    JSON.stringify({current:{objective:objective.includes("Mismatch") ? "Wrong task" : objective}}));
  fs.appendFileSync(path.join(directory, "events.jsonl"),
    JSON.stringify({type:"session.start",data:{selectedModel:"fixture-model",reasoningEffort:"high"}}) + "\\n");
  const send = (type, data) => console.log(JSON.stringify({type,data}));
  send("session.autopilot_objective_changed", {operation:"create"});
  send("tool.execution_start", {toolCallId:"completion",toolName:"task_complete",arguments:{summary:objective}});
  if (objective.includes("Wait for cancellation")) { setInterval(() => {}, 1000); return; }
  send("assistant.message_delta", {messageId:"answer",deltaContent:"Done"});
  send("assistant.message", {messageId:"answer",content:"Done"});
  send("tool.execution_complete", {toolCallId:"completion",success:true,result:{content:"Done"}});
  console.log(JSON.stringify({type:"result",sessionId:id,exitCode:0}));
});
`);
  return { root, cli };
}

async function client(t, root, cli) {
  const source = `import { serveAutopilot } from ${JSON.stringify(new URL("../src/copilot-autopilot.mjs", import.meta.url).href)};
    await serveAutopilot(process.argv.slice(1));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, "--", process.execPath, cli,
    "--acp", "--stdio", "--model", "fixture-model"], {
    cwd: import.meta.dirname, env: { ...process.env, COPILOT_HOME: root }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Adapter exited ${code}`)));
  });
  let sequence = 0, errors = "";
  const pending = new Map(), updates = [];
  child.stderr.on("data", data => { errors += data; });
  createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line);
    if (response.method) updates.push(response.params.update);
    else { pending.get(response.id)?.(response); pending.delete(response.id); }
  });
  const send = value => child.stdin.write(JSON.stringify({jsonrpc:"2.0", ...value}) + "\n");
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => reject(new Error(`${method} timed out: ${errors}`)), 15000);
    pending.set(id, response => {
      clearTimeout(timeout);
      response.error ? reject(new Error(response.error.message)) : resolve(response.result);
    });
    send({id,method,params});
  });
  let closing;
  const close = () => closing ||= (async () => { child.stdin.end(); await closed; })();
  t.after(close);
  assert.equal((await call("initialize", {})).agentCapabilities.loadSession, true);
  return { call, send, close, updates };
}

test("Autopilot runs native prompt mode, verifies objectives, and restores only new assignments", async t => {
  const { root, cli } = fixture(t), first = await client(t, root, cli);
  const sessionId = (await first.call("session/new", {cwd:root})).sessionId;
  const prompt = (provider, text) => provider.call("session/prompt", {
    sessionId, prompt:[{type:"text",text:`/autopilot ${text}`}],
  });
  assert.equal((await prompt(first, "Only the first assignment")).stopReason, "end_turn");
  assert.ok(first.updates.some(update => update.currentModeId?.endsWith("#autopilot")));
  assert.equal(first.updates.filter(update => update.sessionUpdate === "agent_message_chunk").length, 1);
  assert.ok(first.updates.some(update => update.sessionUpdate === "tool_call_update" && update.status === "completed"));
  await first.close();
  const restored = await client(t, root, cli);
  const session = await restored.call("session/load", {cwd:root,sessionId});
  assert.equal(session.models.currentModelId, "fixture-model");
  assert.equal(session.configOptions[0].currentValue, "high");
  assert.equal((await prompt(restored, "Only the subsequent assignment")).stopReason, "end_turn");
  const stored = JSON.parse(fs.readFileSync(path.join(root, "session-state", sessionId, "autopilot-objective.json")));
  assert.equal(stored.current.objective, "Only the subsequent assignment");
});

test("Autopilot rejects mismatched objectives and invalid session identities", async t => {
  const { root, cli } = fixture(t), provider = await client(t, root, cli);
  const sessionId = (await provider.call("session/new", {cwd:root})).sessionId;
  await assert.rejects(provider.call("session/prompt", {sessionId:"another-session",prompt:[]}), /identity does not match/);
  await assert.rejects(provider.call("session/prompt", {sessionId,prompt:[{type:"text",text:"/autopilot Mismatch"}]}),
    /exactly the incoming objective/);
  assert.ok(!provider.updates.some(update => update.currentModeId?.endsWith("#autopilot")));
});

test("Autopilot cancels only its owned CLI and can resume the saved session", async t => {
  const { root, cli } = fixture(t), provider = await client(t, root, cli);
  const sessionId = (await provider.call("session/new", {cwd:root})).sessionId;
  const turn = provider.call("session/prompt", {sessionId,prompt:[{type:"text",text:"/autopilot Wait for cancellation"}]});
  const deadline = Date.now() + 10000;
  while (!provider.updates.some(update => update.sessionUpdate === "tool_call")) {
    assert.ok(Date.now() < deadline, "CLI did not start");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  provider.send({method:"session/cancel",params:{sessionId}});
  assert.equal((await turn).stopReason, "cancelled");
  assert.equal((await provider.call("session/prompt", {
    sessionId,prompt:[{type:"text",text:"/autopilot Only the resumed assignment"}],
  })).stopReason, "end_turn");
});
