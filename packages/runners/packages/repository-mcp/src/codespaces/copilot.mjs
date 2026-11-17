import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Console } from "node:console";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Server } from "@modelcontextprotocol/server";
import { proxyServer, startHTTPServer } from "mcp-proxy";
import { readCodespaceConfig, shellQuote, sshInvocation } from "./config.mjs";
import { CodespaceTransport } from "./transport.mjs";
import { vmApplicationAuthentication } from "./application-vm.mjs";
import { deployedPreview } from "./deployed-browser.mjs";
import { verifySavedCodespace } from "./review.mjs";
import { decide } from "../../../bohemia-pr-mcp/src/bypass-guard.ts";
import { operatorConversation, readJson, samePath } from "../../../../bridge/spool-files.mjs";

export function nativeOperatorConversation(config, server, providerToken = process.env.SPOOL_PROVIDER_TOKEN) {
  const args = server?.args || [];
  const argument = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const root = argument("--root"), id = argument("--task"), agent = argument("--agent");
  if (!path.isAbsolute(root || "") || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,179}$/.test(id || "") ||
      !providerToken || !agent) return false;
  const task = readJson(path.join(root, "queues", "in_progress", `${id}.json`));
  const provider = readJson(path.join(root, "spool.json"))?.copilotProviders?.[agent];
  const configured = provider?.args || [], index = configured.indexOf("--config");
  if (!task || task.id !== id || task.agent !== agent || task.provider?.token !== providerToken ||
      !samePath(task.workspace, config.workspace) || index < 0 ||
      !samePath(configured[index + 1], config.file)) return false;
  if (operatorConversation(root, task)) return true;
  return !!(task.session_id && task.interaction?.messages?.some(message => {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(message.id || "") ||
        !["queued", "delivering"].includes(message.status) ||
        !task.interaction.applied_requests?.includes(message.id)) return false;
    const command = readJson(path.join(root, "controls", "commands", `${message.id}.json`));
    return command?.input?.kind === "message" && command.input.metadata === undefined &&
      command.input.id === message.id && command.input.taskId === id && command.input.message === message.text &&
      command.conversation?.sessionId === task.session_id && command.request?.kind === "message" &&
      command.request.taskId === id && command.request.agent === agent &&
      samePath(command.request.workspace, config.workspace);
  }));
}

export async function nativeSessionOwner(config, verify = verifySavedCodespace, transport, server) {
  if (config.purpose === "engineering") return;
  // Operator conversations own their lease rather than borrowing an old PR's preparation.
  if (nativeOperatorConversation(config, server)) return;
  const prepared = JSON.parse(fs.readFileSync(path.join(config.workspace, "preparation.json"), "utf8"));
  if (!Number.isSafeInteger(prepared.ownerPid) || prepared.ownerPid <= 0)
    throw new Error("Native reviewer requires its live runner-owned preparation");
  await verify(prepared, { transport, allowRevisionDrift: true });
  return { codespace: config.codespace, root: config.remoteRoot, tools: config.remoteTools,
    token: prepared.leaseToken, pid: prepared.ownerPid };
}

export async function restoreNativeReview(config, transport, server) {
  if (config.purpose !== "review" || transport.borrowed || !nativeOperatorConversation(config, server)) return;
  const args = server.args, root = args[args.indexOf("--root") + 1], id = args[args.indexOf("--task") + 1];
  const task = readJson(path.join(root, "queues", "in_progress", `${id}.json`));
  const metadata = task?.runner_metadata || readJson(path.join(root, ".runner-receipts", `task-${id}.json`));
  if (metadata?.runner !== "pr-reviewer") return;
  const commit = metadata?.preparation?.commit;
  if (!/^[a-f0-9]{40}$/i.test(commit || "")) return;
  const git = `git -C ${shellQuote(config.remoteRoot)}`;
  await transport.ssh(`set -e\n` +
    `if test "$(${git} rev-parse HEAD)" != ${shellQuote(commit)}; then\n` +
    `  ${git} diff --no-ext-diff --quiet && ${git} diff --cached --no-ext-diff --quiet || ` +
    `{ echo "Original review source cannot replace tracked work" >&2; exit 1; }\n` +
    `  ${git} switch --detach --no-overwrite-ignore ${shellQuote(commit)}\nfi\n` +
    `test "$(${git} rev-parse HEAD)" = ${shellQuote(commit)}`, 300);
}

export function nativeAgentRole(config, originalRole, repositoryInstructions) {
  if (config.purpose === "review" || !repositoryInstructions) return originalRole;
  return Buffer.from([originalRole?.toString("utf8"), repositoryInstructions].filter(Boolean).join("\n\n"));
}

export function nativeApplicationContext(config, server, registered =
  readJson(path.join(os.homedir(), ".copilot", "repository-mcp.json"))) {
  if (config.purpose !== "review" || !config.sshHost || registered?.version !== 1 ||
      !samePath(config.file, registered.codespaceReview) || !registered.applicationAuth?.ownerConfig ||
      !registered.codespaceWorkspaces?.some(file => samePath(file, registered.applicationAuth.ownerConfig))) return;
  const args = server?.args || [];
  const argument = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const root = argument("--root"), id = argument("--task");
  if (!path.isAbsolute(root || "") || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,179}$/.test(id || "")) return;
  const task = readJson(path.join(root, "queues", "in_progress", `${id}.json`));
  const metadata = task?.runner_metadata || readJson(path.join(root, ".runner-receipts", `task-${id}.json`));
  const prepared = metadata?.preparation;
  if (!task || task.agent !== argument("--agent") || !samePath(task.workspace, config.workspace) ||
      metadata?.runner !== "pr-reviewer" || !Number.isSafeInteger(prepared?.prId) || prepared.prId < 1 ||
      !/^[a-f0-9]{40}$/i.test(prepared.sourceCommit || "")) return;
  const target = deployedPreview(prepared.prId, prepared.sourceCommit);
  return { taskId: id, authorization: "registered-application-owner", ...target,
    browser: { module: `${config.remoteTools}/repository-mcp/src/codespaces/deployed-browser.mjs`,
      export: "openDeployedApplicationBrowser", arguments: [`${config.remoteTools}/deployed-application`, target] } };
}

export function remoteArguments(args) {
  const result = [], servers = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--acp", "--stdio"].includes(arg)) continue;
    if (arg === "--log-dir") {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Missing local log directory");
      index++; continue;
    }
    if (arg === "--additional-mcp-config") {
      Object.assign(servers, JSON.parse(args[++index]).mcpServers);
      continue;
    }
    if (!["--model", "--reasoning-effort"].includes(arg) || !args[index + 1] || args[index + 1].startsWith("-"))
      throw new Error(`Unsupported remote Copilot option: ${arg}`);
    result.push(arg, args[++index]);
  }
  return { args: result, servers };
}

export function nativeCopilotCommand(args, autopilot = false) {
  const options = `--acp --stdio ${args.map(shellQuote).join(" ")} --additional-mcp-config "$MCP_CONFIG"`;
  if (!autopilot) return `copilot ${options}`;
  return 'node --input-type=module -e "$(printf %s "$SPOOL_COPILOT_AUTOPILOT_SOURCE" | base64 -d)" ' +
    `-- spool-copilot-autopilot copilot ${options}`;
}

export function withNativeInstructions(command) {
  return 'IFS= read -r SPOOL_AGENT_ROLE_SOURCE && IFS= read -r SPOOL_COPILOT_AUTOPILOT_SOURCE; ' +
    'if [ -n "$SPOOL_AGENT_ROLE_SOURCE" ]; then ' +
    'SPOOL_AGENT_ROLE_DIRECTORY="$(mktemp -d)" || exit 1; ' +
    'trap \'rm -f -- "$SPOOL_AGENT_ROLE_DIRECTORY/role.instructions.md"; rmdir -- "$SPOOL_AGENT_ROLE_DIRECTORY"\' EXIT; ' +
    'printf %s "$SPOOL_AGENT_ROLE_SOURCE" | base64 -d > "$SPOOL_AGENT_ROLE_DIRECTORY/role.instructions.md" || exit 1; ' +
    'chmod 600 "$SPOOL_AGENT_ROLE_DIRECTORY/role.instructions.md" || exit 1; ' +
    'export COPILOT_CUSTOM_INSTRUCTIONS_DIRS="${COPILOT_CUSTOM_INSTRUCTIONS_DIRS:+$COPILOT_CUSTOM_INSTRUCTIONS_DIRS,}$SPOOL_AGENT_ROLE_DIRECTORY"; ' +
    `fi; ${command}`;
}

export function nativeMcpServers(servers, configured, purpose) {
  const names = purpose === "engineering" ? ["repository", "figma", "discord"] : ["repository", "discord"];
  const selected = { ...servers, ...Object.fromEntries(names.filter(name => configured[name])
    .map(name => [name, configured[name]])) };
  if (purpose === "engineering" && /(?:^|[\\/])node(?:\.exe)?$/i.test(selected.figma?.command || "")) {
    const figma = selected.figma;
    selected.figma = { ...figma, env: { ...figma.env, NODE_OPTIONS: [
      figma.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? "",
      `--import=${new URL("./figma-fetch.mjs", import.meta.url).href}`,
    ].filter(Boolean).join(" ") } };
  }
  return selected;
}

export function nativeToolHook(request, cwd) {
  if (request.method !== "spool/preToolUse") return null;
  const input = request.params?.input;
  const decision = decide(input?.toolName || "", input?.toolArgs || {}, cwd);
  return { jsonrpc: "2.0", id: request.id, result: { output: decision.deny
    ? { permissionDecision: "deny", permissionDecisionReason: decision.reason } : {} } };
}

export async function initializeNativeTransport(config, transport, owner) {
  await transport.initialize(owner);
  await transport.deploy();
}

export function nativeReviewEnvironment(config, borrowed, authFile) {
  const prefix = (config.purpose === "engineering" ? "" : "CI=true ") +
    (config.purpose === "review" && config.remoteTools
      ? 'NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=' +
        `${config.remoteTools}/repository-mcp/src/codespaces/native-review-process.mjs" ` : "");
  if (!authFile && (config.purpose === "engineering" || !borrowed)) return prefix;
  return `${prefix}SPOOL_REVIEW_AZURE_AUTH_FILE=${shellQuote(authFile || `${config.remoteTools}/azure-auth.json`)} ` +
    `PATH=${shellQuote(`${config.remoteTools}/host-auth/bin`)}:"$PATH" `;
}

export async function authenticateNativeTool(request, hook, authentication, vmAuthentication, repositoryAuthentication,
  respond = () => {}) {
  if (!hook) return;
  respond(hook);
  if (hook.result?.output?.permissionDecision === "deny") return;
  const tool = request.params?.input?.toolName || "";
  if (tool === "bash" || /(?:^|[_./-])repo_(?:prepare|build|check|pr)$/.test(tool))
    await repositoryAuthentication?.ensure();
  if (tool === "bash") {
    const errors = [];
    for (const provider of [vmAuthentication, authentication]) {
      try { await provider?.ensure(); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Managed application sign-in is not ready");
  }
}

export function relayNativeInput(input, child, receive) {
  const incoming = createInterface({ input }).on("line", receive);
  incoming.once("close", () => child.stdin.end());
  child.once("close", () => {
    incoming.close();
    input.pause();
  });
  return incoming;
}

export function withCurrentAgentRole(request, server) {
  const args = server?.args || [];
  const root = args[args.indexOf("--root") + 1], agent = args[args.indexOf("--agent") + 1];
  if (!args.includes("--root") || !args.includes("--agent") || !path.isAbsolute(root || "") ||
      !/^[a-z0-9][a-z0-9-]*$/.test(agent || ""))
    throw new Error("Restored reviewer requires its task-bound agent role");
  const role = fs.readFileSync(path.join(root, "agents", `${agent}.md`), "utf8")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return { ...request, params: { ...request.params,
    prompt: [...request.params.prompt, { type: "text", text: role }] } };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function serveMcp(spec, environment = {}, application) {
  if (!spec || !["local", "stdio", undefined].includes(spec.type) || typeof spec.command !== "string")
    throw new Error("Remote Copilot requires explicit local MCP commands");
  const port = await freePort(), key = randomUUID();
  const upstream = new Client({ name: "spool-remote-transport", version: "1" });
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args || [],
    env: { ...process.env, ...(spec.env || {}), ...environment }, cwd: spec.cwd, stderr: "inherit" });
  try {
    await upstream.connect(transport);
    if (application) {
      const request = upstream.request.bind(upstream);
      upstream.request = async (input, ...args) => {
        const result = await request(input, ...args);
        if (input.method === "tools/call" && input.params?.name === "spool_update_task_status" && !result.isError)
          return { ...result, content: [...(result.content || []),
            { type: "text", text: JSON.stringify({ application }, null, 2) }] };
        if (input.method !== "tools/call" || input.params?.name !== "spool_get_task" || result.isError) return result;
        const attach = task => task?.id === application.taskId ? { application, ...task } : task;
        return { ...result, ...(result.structuredContent && { structuredContent: attach(result.structuredContent) }),
          content: result.content?.map(item => {
            if (item.type !== "text") return item;
            try { return { ...item, text: JSON.stringify(attach(JSON.parse(item.text)), null, 2) }; }
            catch { return item; }
          }) };
      };
    }
    const capabilities = upstream.getServerCapabilities();
    const server = await startHTTPServer({
      host: "127.0.0.1", port, apiKey: key, cors: false, sseEndpoint: null,
      modern: false,
      createServer: async () => {
        const downstream = new Server(upstream.getServerVersion(), { capabilities });
        await proxyServer({ client: upstream, server: downstream, serverCapabilities: capabilities,
          requestTimeout: 21_600_000 });
        return downstream;
      },
    });
    return { port, key, close: async () => {
      try { await server.close(); } finally { await upstream.close(); }
    } };
  } catch (error) { await upstream.close(); throw error; }
}

export function nativeRemoteMcpServers(servers) {
  return Object.fromEntries(Object.entries(servers).filter(([, server]) => {
    if (server.type !== "http") return false;
    if (new URL(server.url).protocol !== "https:")
      throw new Error("Native remote MCP servers require HTTPS");
    return true;
  }));
}

export async function startMcpGateways(servers, environment, gateways, start = serveMcp) {
  const remote = nativeRemoteMcpServers(servers);
  const attempts = await Promise.allSettled(Object.entries(servers).filter(([name]) => !(name in remote)).map(async ([name, server]) => {
    gateways.set(name, await start(server, environment, name));
  }));
  // Wait for every startup before cleanup, including gateways that finish after another fails.
  const failed = attempts.find(attempt => attempt.status === "rejected");
  if (failed) throw failed.reason;
}

async function syncUsage(transport, sessionId) {
  if (!/^[a-f0-9-]{36}$/.test(sessionId || "") || !process.env.SPOOL_COPILOT_USAGE_ROOT)
    throw new Error("Remote session usage destination or identity is missing");
  const program = `const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),` +
    `id=${JSON.stringify(sessionId)},home=process.env.COPILOT_HOME||path.join(os.homedir(),".copilot");` +
    `const lines=fs.readFileSync(path.join(home,"session-state",id,"events.jsonl"),"utf8").split("\\n");` +
    `for(const line of lines){if(!line)continue;const e=JSON.parse(line);` +
    `if(e.agentId||!["session.start","session.resume","assistant.turn_start","user.message","session.shutdown"].includes(e.type))continue;` +
    `e.data=e.type==="session.start"?{sessionId:e.data.sessionId}:e.type==="session.shutdown"?{modelMetrics:e.data.modelMetrics}:{};` +
    `console.log(JSON.stringify(e));}`;
  const { stdout } = await transport.ssh(`${shellQuote(transport.config.nativeProfile.nodeExecutable)} -e ${shellQuote(program)}`, 60);
  const directory = path.join(process.env.SPOOL_COPILOT_USAGE_ROOT, sessionId);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `events-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, stdout, { mode: 0o600 });
  fs.renameSync(temporary, path.join(directory, "events.jsonl"));
}

export async function finishNativeSession(code, sessionId, synchronize) {
  if (code !== 0) throw new Error(`Native remote Copilot exited (${code})`);
  if (sessionId) await synchronize(sessionId);
}

export async function main(argv = process.argv.slice(2)) {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  if (argv[0] !== "--config" || !argv[1]) throw new Error("Usage: copilot.mjs --config <absolute file> [Copilot options]");
  const config = readCodespaceConfig(argv[1], { createWorkspace: true });
  const parsed = remoteArguments(argv.slice(2));
  const role = nativeAgentRole(config, process.env.SPOOL_AGENT_INSTRUCTIONS
    ? fs.readFileSync(process.env.SPOOL_AGENT_INSTRUCTIONS) : null);
  const autopilot = role !== null;
  const adapter = autopilot ? Buffer.from(fs.readFileSync(new URL("../copilot-autopilot.mjs", import.meta.url), "utf8") +
    "\nawait serveNativeAutopilot(process.argv.slice(2));") : null;
  const globalFile = path.join(os.homedir(), ".copilot", "mcp-config.json");
  if (fs.existsSync(globalFile)) {
    const configured = JSON.parse(fs.readFileSync(globalFile, "utf8")).mcpServers || {};
    parsed.servers = nativeMcpServers(parsed.servers, configured, config.purpose);
  }
  const progress = message => console.error(`[Copilot ACP setup] ${message}`);
  const transport = new CodespaceTransport(config, { onProgress: progress, leaseWaitSeconds: 300 });
  const gateways = new Map();
  const pendingHooks = new Set();
  const vmAuthentication = config.sshHost && config.purpose === "engineering"
    ? vmApplicationAuthentication(config, transport) : undefined;
  let child, sessionId, incoming, disconnected = false;
  const output = line => { if (!disconnected) process.stdout.write(line + "\n"); };
  const disconnect = error => {
    disconnected = true;
    process.exitCode = 1;
    if (error.code !== "EPIPE") console.error(error.message);
    incoming?.close();
    process.stdin.pause();
    child?.stdin?.end();
  };
  process.stdout.on("error", disconnect);
  try {
    progress("Verifying runner-owned preparation");
    await initializeNativeTransport(config, transport,
      await nativeSessionOwner(config, verifySavedCodespace, transport, parsed.servers.spool));
    try { await restoreNativeReview(config, transport, parsed.servers.spool); }
    catch (error) { progress(`Original review checkout was not restored; existing work was preserved: ${error.message}`); }
    const environment = { REPOSITORY_CODESPACE_SESSION: JSON.stringify({
      codespace: config.codespace, root: config.remoteRoot, tools: config.remoteTools,
      ...(config.sshHost ? { sshHost: config.sshHost } : {}),
      token: transport.leaseToken, pid: process.pid,
    }) };
    await startMcpGateways(parsed.servers, environment, gateways, async (server, env, name) => {
      progress(`Starting MCP gateway: ${name}`);
      const gateway = await serveMcp(server, env, name === "spool" ? nativeApplicationContext(config, server) : undefined);
      progress(`MCP gateway ready: ${name}`);
      return gateway;
    });
    progress("Establishing private MCP SSH forwards");
    const forwards = [...gateways.values()].flatMap(gateway => ["-R", `0:127.0.0.1:${gateway.port}`]);
    const command = `IFS= read -r COPILOT_GITHUB_TOKEN && export COPILOT_GITHUB_TOKEN; ` +
      `IFS= read -r MCP_CONFIG; cd ${shellQuote(config.remoteRoot)} && ` +
      withNativeInstructions(`env -u COPILOT_ALLOW_ALL ${transport.gitEnvironment} ` +
        nativeReviewEnvironment(config, transport.borrowed, transport.azureAuthFile) +
        nativeCopilotCommand(parsed.args, autopilot));
    transport.github.check(config.codespace);
    transport.github.record("copilot-connect", config.codespace);
    const connection = sshInvocation(config, ["-4", "-T",
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=30", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3", ...forwards, command]);
    child = spawn(connection.command, connection.args,
    { env: transport.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code));
    });
    child.stdin.on("error", () => {});
    const acquired = new Set();
    let begin;
    const forwarded = new Promise(resolve => { begin = resolve; });
    const errors = createInterface({ input: child.stderr });
    errors.on("line", line => {
      const match = line.match(/Allocated port (\d+) for remote forward to 127\.0\.0\.1:(\d+)/);
      if (match) {
        const gateway = [...gateways.values()].find(value => value.port === Number(match[2]));
        if (gateway) { gateway.remotePort = Number(match[1]); acquired.add(gateway); }
        if (acquired.size === gateways.size) begin();
      } else {
        const error = new Error(line);
        transport.github.failed(error, config.codespace);
        process.stderr.write(line + "\n");
        if (error.retryAt) progress(`${error.code} retryAt=${error.retryAt}`);
      }
    });
    if (gateways.size) {
      const started = await Promise.race([forwarded.then(() => true), closed.then(() => false)]);
      if (!started) throw new Error("SSH closed before the private MCP forwards were established");
    }
    const mcpServers = { ...nativeRemoteMcpServers(parsed.servers), ...Object.fromEntries([...gateways].map(([name, gateway]) => [name, {
      type: "http", url: `http://127.0.0.1:${gateway.remotePort}/mcp`, tools: ["*"],
      headers: { "X-API-Key": gateway.key }, timeout: 21_600_000,
    }])) };
    progress("Starting remote Copilot ACP");
    child.stdin.write(transport.env.GH_TOKEN + "\n" + JSON.stringify({ mcpServers }) + "\n" +
      (role?.toString("base64") || "") + "\n" + (adapter?.toString("base64") || "") + "\n");
    const requests = new Map();
    let restoredRole = false;
    const identity = { codespace: config.codespace, root: config.remoteRoot,
      ...(config.sshHost ? { sshHost: config.sshHost } : {}) };
    const identityFile = id => {
      if (!/^[a-f0-9-]{36}$/.test(id || "") || !process.env.SPOOL_COPILOT_USAGE_ROOT)
        throw new Error("Remote session identity is invalid");
      return path.join(process.env.SPOOL_COPILOT_USAGE_ROOT, id, "provider.json");
    };
    incoming = relayNativeInput(process.stdin, child, line => {
      const request = JSON.parse(line);
      if (["session/new", "session/load"].includes(request.method) && request.params?.cwd !== config.remoteRoot) {
        output(JSON.stringify({ jsonrpc: "2.0", id: request.id,
          error: { code: -32602, message: "Remote working directory does not match the assigned Codespace" } }));
        return;
      }
      if (request.method === "session/load") {
        try {
          if (JSON.stringify(JSON.parse(fs.readFileSync(identityFile(request.params.sessionId), "utf8"))) !== JSON.stringify(identity))
            throw new Error("Remote Copilot session belongs to another Codespace");
          sessionId = request.params.sessionId;
          restoredRole = config.purpose === "review" && !autopilot;
        } catch {
          output(JSON.stringify({ jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Remote Copilot session owner could not be verified" } }));
          return;
        }
      }
      if (request.method === "session/prompt" && restoredRole) {
        line = JSON.stringify(withCurrentAgentRole(request, parsed.servers.spool));
        restoredRole = false;
      }
      if (["session/new", "session/load"].includes(request.method)) requests.set(request.id, request.method);
      child.stdin.write(line + "\n");
    });
    createInterface({ input: child.stdout }).on("line", line => {
      const response = JSON.parse(line);
      const hook = nativeToolHook(response, config.remoteRoot);
      if (hook) {
        const pending = authenticateNativeTool(response, hook, undefined, vmAuthentication, undefined, () => {
          if (!disconnected && !child.stdin.destroyed) child.stdin.write(JSON.stringify(hook) + "\n");
        }).catch(() => progress("Background authentication is not ready; local commands remain available"));
        pendingHooks.add(pending);
        pending.then(() => pendingHooks.delete(pending), () => pendingHooks.delete(pending));
        return;
      }
      if (requests.has(response.id) && response.result?.sessionId) {
        sessionId = response.result.sessionId;
        if (requests.get(response.id) === "session/new") {
          const file = identityFile(sessionId);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(identity), { flag: "wx", mode: 0o600 });
        }
      }
      output(line);
    });
    await finishNativeSession(await closed, sessionId, id => syncUsage(transport, id));
  } finally {
    incoming?.close();
    process.stdin.pause();
    process.stdout.off("error", disconnect);
    await Promise.allSettled([...pendingHooks]);
    try {
      const closed = await Promise.allSettled([...gateways.values()].map(gateway => gateway.close()));
      const failed = closed.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
    }
    finally { await transport.dispose(); }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main().catch(error => {
    console.error(error.message);
    if (error.retryAt) console.error(`[Copilot ACP setup] ${error.code} retryAt=${error.retryAt}`);
    else console.error(`[Copilot ACP setup] ${error.message.replace(/\s+/g, " ").slice(0, 1900)}`);
    process.exitCode = 1;
  });
