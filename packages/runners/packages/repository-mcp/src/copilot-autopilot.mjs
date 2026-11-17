import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const autopilotMode = "https://agentclientprotocol.com/protocol/session-modes#autopilot";
const interactiveMode = "https://agentclientprotocol.com/protocol/session-modes#agent";

const sessionDirectory = id => path.join(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "session-state", id);
const initializationFile = id => path.join(sessionDirectory(id), "spool-autopilot-initialization.json");

function savedSession(id) {
  const directory = sessionDirectory(id);
  const events = fs.readFileSync(path.join(directory, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  let model, reasoning, metrics;
  for (const event of events) {
    if (event.agentId) continue;
    if (event.type === "session.start") {
      model = event.data.selectedModel;
      reasoning = event.data.reasoningEffort;
    } else if (event.type === "session.model_change") {
      model = event.data.newModel;
      reasoning = event.data.reasoningEffort;
    } else if (event.type === "session.shutdown") metrics = event.data.modelMetrics;
  }
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const metric of Object.values(metrics || {}))
    for (const key of Object.keys(usage)) usage[key] += metric.usage?.[key] || 0;
  return { directory, model, reasoning, usage };
}

export async function serveAutopilot(argv) {
  const [program, ...arguments_] = argv;
  if (!program) throw new Error("Missing Copilot executable");
  const args = arguments_.filter(arg => !["--acp", "--stdio", "--autopilot"].includes(arg));
  const option = name => args[args.indexOf(name) + 1];
  if (!args.includes("--model")) throw new Error("Autopilot requires an explicit session model");
  let session, active;
  const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const update = value => send({ method: "session/update", params: { sessionId: session.id, update: value } });
  const describe = () => ({
    sessionId: session.id, models: { currentModelId: session.model },
    modes: { currentModeId: interactiveMode },
    configOptions: session.reasoning ? [{
      id: "reasoning_effort", type: "select", currentValue: session.reasoning,
    }] : [],
  });
  const lines = createInterface({ input: process.stdin });
  const stop = execution => {
    if (execution.stopping || !execution.child.pid) return;
    execution.stopping = true;
    if (process.platform === "win32") {
      const terminate = spawn("taskkill.exe", ["/PID", String(execution.child.pid), "/T", "/F"], { windowsHide: true });
      terminate.on("error", error => process.stderr.write(`${error.message}\n`));
    } else execution.child.kill("SIGINT");
  };
  const turn = async request => {
    const prompt = request.params.prompt;
    if (!Array.isArray(prompt) || prompt.length !== 1 || prompt[0].type !== "text" ||
        !prompt[0].text.startsWith("/autopilot ")) throw new Error("Expected one task-scoped /autopilot objective");
    const objective = prompt[0].text.slice("/autopilot ".length).trim();
    if (!objective || ["on", "off", "status", "pause", "resume", "clear"].includes(objective.toLowerCase()))
      throw new Error("Autopilot requires an objective, not a mode command");
    const previous = session.restored ? savedSession(session.id).usage : null;
    const child = spawn(program, [...args, "--autopilot",
      session.restored ? "--resume" : "--session-id", session.id, "--output-format", "json"],
    { cwd: session.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const execution = { child, cancelled: false };
    active = execution;
    let result, failure, confirmed = false, stderr = "";
    const streamed = new Set();
    const verify = () => {
      const directory = path.join(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "session-state", session.id);
      const stored = JSON.parse(fs.readFileSync(path.join(directory, "autopilot-objective.json"), "utf8"));
      if (stored.current?.objective !== objective) throw new Error("Copilot did not save exactly the incoming objective");
      if (!confirmed) {
        confirmed = true;
        update({ sessionUpdate: "current_mode_update", currentModeId: autopilotMode });
      }
    };
    child.stderr.on("data", data => {
      stderr = (stderr + data).slice(-4096);
      process.stderr.write(data);
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    createInterface({ input: child.stdout }).on("line", line => {
      try {
        const event = JSON.parse(line), data = event.data || {};
        if (event.agentId) return;
        if (event.type === "user.message" || event.type === "session.autopilot_objective_changed") verify();
        if (event.type === "assistant.message_delta") {
          streamed.add(data.messageId);
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: data.deltaContent || "" } });
        } else if (event.type === "assistant.message" && data.content && !streamed.has(data.messageId)) {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: data.content } });
        } else if (event.type === "tool.execution_start") {
          update({ sessionUpdate: "tool_call", toolCallId: data.toolCallId, title: data.toolName, rawInput: data.arguments });
        } else if (event.type === "tool.execution_complete") {
          update({ sessionUpdate: "tool_call_update", toolCallId: data.toolCallId,
            status: data.success ? "completed" : "failed", rawOutput: data.result });
        } else if (event.type === "session.error") failure = data.message;
        else if (event.type === "result") result = event;
      } catch (error) { failure = error.message; stop(execution); }
      if (execution.cancelled && fs.existsSync(path.join(process.env.COPILOT_HOME ||
          path.join(os.homedir(), ".copilot"), "session-state", session.id, "events.jsonl"))) stop(execution);
    });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") failure = error.message; });
    child.stdin.end(prompt[0].text);
    try {
      const code = await closed;
      session.restored = true;
      if (failure) throw new Error(failure);
      if (execution.cancelled) return { stopReason: "cancelled" };
      if (code !== 0 || result?.exitCode !== 0 || result.sessionId !== session.id)
        throw new Error(`Copilot did not complete the assigned session (${code}): ${stderr}`);
      verify();
      const saved = savedSession(session.id);
      const usage = Object.fromEntries(Object.entries(saved.usage).map(([key, value]) => [key, Math.max(0, value - (previous?.[key] || 0))]));
      return { stopReason: "end_turn", usage };
    } finally { active = undefined; }
  };
  lines.on("line", line => {
    void (async () => {
      let request;
      try {
        request = JSON.parse(line);
        const params = request.params || {};
        let result;
        if (request.method === "initialize") {
          result = { protocolVersion: 1, agentInfo: { name: "spool-copilot-autopilot", version: "1" },
            agentCapabilities: { loadSession: true } };
        } else if (request.method === "session/new" || request.method === "session/load") {
          if (session || active) throw new Error("This provider already owns a session");
          const restored = request.method === "session/load";
          const id = restored ? params.sessionId : randomUUID();
          if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("Invalid session identity");
          if (!path.isAbsolute(params.cwd || "") || !fs.statSync(params.cwd).isDirectory()) throw new Error("Session workspace is unavailable");
          const saved = restored ? savedSession(id) : null;
          session = { id, cwd: params.cwd, restored, model: saved?.model || option("--model"),
            reasoning: saved?.reasoning || (args.includes("--reasoning-effort") ? option("--reasoning-effort") : null) };
          result = describe();
        } else {
          if (!session || params.sessionId !== session.id) throw new Error("Session identity does not match");
          if (request.method === "session/prompt") {
            if (active) throw new Error("An agent turn is already running");
            result = await turn(request);
          } else if (request.method === "session/cancel") {
            if (active && !active.cancelled) {
              active.cancelled = true;
              if (fs.existsSync(path.join(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"),
                  "session-state", session.id, "events.jsonl"))) stop(active);
            }
            return;
          } else if (request.method === "session/set_config_option" && params.configId === "model" && !active) {
            args[args.indexOf("--model") + 1] = params.value;
            session.model = params.value;
            result = { configOptions: describe().configOptions };
          } else throw new Error(`Unsupported provider method: ${request.method}`);
        }
        if (request.id !== undefined) send({ id: request.id, result });
      } catch (error) {
        if (request?.id !== undefined) send({ id: request.id, error: { code: -32000, message: error.message } });
        else process.stderr.write(`${error.message}\n`);
      }
    })();
  });
  await new Promise(resolve => lines.once("close", resolve));
}

export async function serveNativeAutopilot(argv) {
  const [program, ...inputArgs] = argv;
  const args = [], options = {};
  for (let index = 0; index < inputArgs.length; index++) {
    const arg = inputArgs[index];
    if (["--acp", "--stdio", "--autopilot"].includes(arg)) continue;
    if (["--model", "--reasoning-effort", "--additional-mcp-config"].includes(arg)) {
      options[arg] = inputArgs[++index];
      continue;
    }
    args.push(arg);
  }
  if (!program || !options["--model"]) throw new Error("Native Autopilot requires an executable and explicit model");
  const servers = JSON.parse(options["--additional-mcp-config"] || "{}").mcpServers;
  for (const name of ["repository", "spool"])
    if (servers?.[name]) servers[name] = { ...servers[name], deferTools: "never" };
  const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const approvals = new Map(), pending = new Map(), hooks = new Map();
  let session, child, active, sequence = 0, buffer = Buffer.alloc(0), serverError, closed;
  const update = value => send({ method: "session/update", params: { sessionId: session.id, update: value } });
  const wire = message => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  const rejectHooks = () => {
    for (const id of hooks.values()) wire({ id, result: { output: {
      permissionDecision: "deny", permissionDecisionReason: "The agent owner disconnected or cancelled.",
    } } });
    hooks.clear();
  };
  const fail = error => {
    serverError = error;
    for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(error); }
    pending.clear();
    active?.reject(error);
  };
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (serverError) return reject(serverError);
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Native Autopilot ${method} timed out`));
    }, 120000);
    pending.set(id, { resolve, reject, timer });
    wire({ id, method, params });
  });
  const call = (method, params = {}) => rpc(method, { ...params, sessionId: session.id });
  const permissions = async data => {
    if (data.resolvedByHook) return;
    const request = data.permissionRequest;
    let result = { kind: "user-not-available" };
    // The existing ACP owner cannot attest that an automated reply is a human approval.
    if (active && !request?.managedApprovalRequired && !data.promptRequest?.managedApprovalRequired) {
      const id = `spool-permission-${randomUUID()}`;
      const answer = new Promise(resolve => approvals.set(id, resolve));
      send({ id, method: "session/request_permission", params: {
        sessionId: session.id, toolCall: { toolCallId: request?.toolCallId || data.requestId,
          title: request?.intention || request?.toolName || request?.kind || "Permission request",
          rawInput: request, status: "pending" },
        options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" }],
      } });
      const outcome = await answer;
      if (outcome?.outcome === "selected" && outcome.optionId === "allow_once") result = { kind: "approve-once" };
    }
    await call("session.permissions.handlePendingPermissionRequest", { requestId: data.requestId, result });
  };
  const finish = e => {
    if (e.type === "session.idle" && active.consumed.size === 0) return;
    if (!active.messageId) { active.terminals.push(e); return; }
    const data = e.data || {};
    if (e.type === "session.autopilot_stopped") {
      if (data.requestId !== active.messageId) return;
      if (data.reason === "error") active.reject(new Error("Native Autopilot failed"));
      else active.resolve({ stopReason: data.reason === "aborted" ? "cancelled" : "end_turn" });
    } else if (active.consumed.has(active.messageId) && data.mode !== "autopilot") {
      active.resolve({ stopReason: data.aborted ? "cancelled" : "end_turn" });
    }
  };
  const acknowledge = () => {
    if (!active.messageId || !active.consumed.has(active.messageId) || active.acknowledged) return;
    active.acknowledged = true;
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: active.objective } });
  };
  const event = value => {
    if (!session || value.sessionId !== session.id) return;
    const e = value.event, data = e?.data || {};
    if (e?.type === "permission.requested") {
      void permissions(data).catch(fail);
      return;
    }
    if (!active || !e || e.agentId) return;
    if (e.type === "user.message") {
      active.consumed.add(data.messageId);
      acknowledge();
    }
    else if (e.type === "assistant.message_delta") {
      active.streamed.add(data.messageId);
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: data.deltaContent || "" } });
    } else if (e.type === "assistant.message" && data.content && !active.streamed.has(data.messageId)) {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: data.content } });
    } else if (e.type === "tool.execution_start") {
      if (data.toolName === "task_complete") active.completions.set(data.toolCallId, data.arguments?.summary || "");
      update({ sessionUpdate: "tool_call", toolCallId: data.toolCallId, title: data.toolName, rawInput: data.arguments });
    } else if (e.type === "tool.execution_complete") {
      if (data.success && active.completions.has(data.toolCallId)) active.summary = active.completions.get(data.toolCallId);
      update({ sessionUpdate: "tool_call_update", toolCallId: data.toolCallId,
        status: data.success ? "completed" : "failed", rawOutput: data.result });
    } else if (e.type === "assistant.usage") {
      for (const key of Object.keys(active.usage)) active.usage[key] += data[key] || 0;
    } else if (e.type === "session.error") active.reject(new Error(data.message));
    else if (["session.autopilot_stopped", "session.idle"].includes(e.type)) finish(e);
  };
  const start = () => {
    child = spawn(program, [...args, "--headless", "--stdio", "--no-auto-update",
      "--auth-token-env", "COPILOT_GITHUB_TOKEN", "--no-auto-login"],
    { cwd: session.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    closed = new Promise(resolve => child.once("close", resolve));
    child.stderr.on("data", data => process.stderr.write(data));
    child.once("error", fail);
    child.once("close", code => fail(new Error(`Native Autopilot server exited (${code})`)));
    child.stdin.on("error", fail);
    child.stdout.on("data", data => {
      try {
        buffer = Buffer.concat([buffer, data]);
        for (;;) {
          const header = buffer.indexOf("\r\n\r\n");
          if (header < 0) return;
          const length = Number(buffer.subarray(0, header).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
          if (!Number.isSafeInteger(length) || length < 0 || length > 64 * 1024 * 1024)
            throw new Error("Invalid native Autopilot frame");
          if (buffer.length < header + 4 + length) return;
          const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString());
          buffer = buffer.subarray(header + 4 + length);
          if (message.method === "session.event") event(message.params);
          else if (message.method === "hooks.invoke" && message.id !== undefined) {
            if (message.params?.sessionId !== session.id)
              wire({ id: message.id, error: { code: -32602, message: "Hook session identity does not match" } });
            else if (message.params.hookType === "preToolUse") {
              const id = `spool-hook-${randomUUID()}`;
              hooks.set(id, message.id);
              send({ id, method: "spool/preToolUse", params: message.params });
            } else wire({ id: message.id, result: {} });
          } else if (message.method && message.id !== undefined)
            wire({ id: message.id, error: { code: -32601, message: "Client method is not supported" } });
          else {
            const operation = pending.get(message.id);
            if (!operation) continue;
            pending.delete(message.id); clearTimeout(operation.timer);
            message.error ? operation.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
              : operation.resolve(message.result);
          }
        }
      } catch (error) { fail(error); }
    });
  };
  const describe = () => ({ sessionId: session.id, models: { currentModelId: session.model },
    modes: { currentModeId: interactiveMode }, configOptions: session.reasoning ? [{
      id: "reasoning_effort", type: "select", currentValue: session.reasoning,
    }] : [] });
  const turn = async request => {
    const prompt = request.params.prompt;
    if (!Array.isArray(prompt) || prompt.length !== 1 || prompt[0].type !== "text" ||
        !prompt[0].text.startsWith("/autopilot ")) throw new Error("Expected one task-scoped /autopilot objective");
    const objective = prompt[0].text.slice("/autopilot ".length).trim();
    if (!objective || ["on", "off", "status", "pause", "resume", "clear"].includes(objective.toLowerCase()))
      throw new Error("Autopilot requires an objective, not a mode command");
    const file = path.join(sessionDirectory(session.id), "autopilot-objective.json");
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, nextId: 1 };
    if (previous.version !== 1 || !Number.isSafeInteger(previous.nextId) || previous.nextId < 1)
      throw new Error("Unsupported saved Autopilot objective");
    const timestamp = new Date().toISOString();
    const state = { version: 1, nextId: previous.nextId + 1, current: { id: previous.nextId, objective,
      status: "active", autopilotOrigin: "user", continuationCount: 0, turnCount: 0, tokenCount: 0,
      creditCountNanoAiu: 0, resumeCount: 0, createdAt: timestamp, updatedAt: timestamp } };
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    done.catch(() => {});
    active = { resolve, reject, objective, streamed: new Set(), completions: new Map(), consumed: new Set(), terminals: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    try {
      await call("session.workspaces.writeAutopilotObjective", { content: JSON.stringify(state) });
      if (JSON.parse(fs.readFileSync(file, "utf8")).current?.objective !== objective)
        throw new Error("Copilot did not save exactly the incoming objective");
      await call("session.mode.set", { mode: "autopilot" });
      if (await call("session.mode.get") !== "autopilot") throw new Error("Native Autopilot mode was not confirmed");
      update({ sessionUpdate: "current_mode_update", currentModeId: autopilotMode });
      if (fs.existsSync(initializationFile(session.id))) fs.unlinkSync(initializationFile(session.id));
      active.messageId = (await call("session.send", { prompt: objective, agentMode: "autopilot" })).messageId;
      if (!active.messageId) throw new Error("Native Autopilot did not acknowledge the assigned message");
      acknowledge();
      for (const terminal of active.terminals.splice(0)) finish(terminal);
      const result = await done;
      if (result.stopReason === "end_turn" && active.summary !== undefined) {
        state.current.status = "completed";
        state.current.completionSummary = active.summary;
        state.current.updatedAt = new Date().toISOString();
        await call("session.workspaces.writeAutopilotObjective", { content: JSON.stringify(state) });
      }
      return { ...result, usage: active.usage };
    } finally { active = undefined; }
  };
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    void (async () => {
      let request;
      try {
        request = JSON.parse(line);
        if (!request.method) {
          if (hooks.has(request.id)) {
            const id = hooks.get(request.id);
            hooks.delete(request.id);
            wire({ id, result: request.result });
            return;
          }
          const answer = approvals.get(request.id);
          approvals.delete(request.id);
          answer?.(request.result?.outcome);
          return;
        }
        const params = request.params || {};
        let result;
        if (request.method === "initialize") {
          result = { protocolVersion: 1, agentInfo: { name: "spool-copilot-autopilot", version: "1" },
            agentCapabilities: { loadSession: true } };
        } else if (["session/new", "session/load"].includes(request.method)) {
          if (session) throw new Error("This provider already owns a session");
          const restored = request.method === "session/load", id = restored ? params.sessionId : randomUUID();
          if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("Invalid session identity");
          if (!path.isAbsolute(params.cwd || "") || !fs.statSync(params.cwd).isDirectory())
            throw new Error("Session workspace is unavailable");
          let saved = null, reinitialize = false;
          if (restored) {
            try { saved = savedSession(id); }
            catch (error) {
              if (error.code !== "ENOENT") throw error;
              saved = JSON.parse(fs.readFileSync(initializationFile(id), "utf8"));
              if (saved.version !== 1 || saved.id !== id || saved.cwd !== params.cwd ||
                  typeof saved.model !== "string" || !saved.model)
                throw new Error("Unstarted native session initialization could not be verified");
              reinitialize = true;
            }
          }
          session = { id, cwd: params.cwd, model: saved?.model || options["--model"],
            reasoning: saved?.reasoning || options["--reasoning-effort"] };
          start();
          let connection;
          try { connection = await rpc("connect"); }
          catch (error) { if (error.code !== -32601) throw error; connection = await rpc("ping"); }
          if (connection.protocolVersion !== 3) throw new Error("Native Autopilot requires SDK protocol version 3");
          const admitted = await call(restored && !reinitialize ? "session.resume" : "session.create", {
            model: session.model, reasoningEffort: session.reasoning, workingDirectory: session.cwd,
            enableSkills: true, skillDirectories: [path.join(session.cwd, ".github", "skills")],
            requestPermission: true, hooks: true, streaming: true, infiniteSessions: { enabled: true }, mcpServers: servers,
          });
          if (admitted.sessionId !== id) throw new Error("Native Autopilot session identity changed");
          if (!restored) fs.writeFileSync(initializationFile(id), JSON.stringify({
            version: 1, id, cwd: session.cwd, model: session.model, reasoning: session.reasoning,
          }), { flag: "wx", mode: 0o600 });
          result = describe();
        } else {
          if (!session || params.sessionId !== session.id) throw new Error("Session identity does not match");
          if (request.method === "session/prompt") {
            if (active) throw new Error("An agent turn is already running");
            result = await turn(request);
          } else if (request.method === "session/cancel") {
            rejectHooks();
            for (const answer of approvals.values()) answer(null);
            approvals.clear();
            if (active) await call("session.abort");
            return;
          } else if (request.method === "session/set_config_option" && params.configId === "model" && !active) {
            await call("session.model.switchTo", { modelId: params.value });
            session.model = params.value;
            result = { configOptions: describe().configOptions };
          } else throw new Error(`Unsupported provider method: ${request.method}`);
        }
        if (request.id !== undefined) send({ id: request.id, result });
      } catch (error) {
        if (request?.id !== undefined) send({ id: request.id, error: { code: -32000, message: error.message } });
        else process.stderr.write(`${error.message}\n`);
      }
    })();
  });
  await new Promise(resolve => lines.once("close", resolve));
  rejectHooks();
  for (const answer of approvals.values()) answer(null);
  approvals.clear();
  if (child) {
    try { if (active) await call("session.abort"); await call("session.destroy"); }
    finally { child.stdin.end(); await closed; }
  }
}
