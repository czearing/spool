import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { authenticateNativeTool, finishNativeSession, initializeNativeTransport, nativeAgentRole, nativeApplicationContext, nativeMcpServers, nativeOperatorConversation, nativeRemoteMcpServers, nativeReviewEnvironment, nativeSessionOwner, nativeToolHook, remoteArguments, relayNativeInput, restoreNativeReview, serveMcp,
  startMcpGateways, withCurrentAgentRole } from "../src/codespaces/copilot.mjs";
import { CodespaceTransport } from "../src/codespaces/transport.mjs";
import { withFigmaVariableTimeout } from "../src/codespaces/figma-fetch.mjs";
import { codespaceConnectionFailure } from "../src/codespaces/github-requests.mjs";

test("native reviewers keep their original role without conflicting PR-authoring restrictions", () => {
  const original = Buffer.from("Post every verified finding and approve clean reviews.");
  const authoring = "Update PR descriptions through repository functions. Never post PR comments.";
  assert.equal(nativeAgentRole({ purpose: "review" }, original, authoring), original);
  assert.equal(nativeAgentRole({ purpose: "engineering" }, original, authoring).toString(),
    original.toString() + "\n\n" + authoring);
  assert.equal(nativeAgentRole({ purpose: "engineering" }, original), original);
});

test("native review diff generation preserves full output beyond its buffer without changing PR source", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-review-buffer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (args, options = {}) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", ...options }).trim();
  git(["init", "--quiet"]);
  const empty = git(["mktree"], { input: "" });
  const base = git(["commit-tree", empty], { input: "Base fixture\n" });
  const blob = git(["hash-object", "-w", "--stdin"], { input: "Reviewed resource value\n".repeat(10000) });
  const tree = git(["mktree"], { input: `100644 blob ${blob}\tresources.txt\n` });
  const head = git(["commit-tree", tree, "-p", base], { input: "Review fixture\n" });
  const command = `git diff ${base}...${head}`;
  const expected = execFileSync("git", ["diff", `${base}...${head}`], { cwd: root, encoding: "utf8" });
  const file = path.join(root, "midgard", "packages", "review-agents", "src", "pr", "fetch.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `import assert from "node:assert/strict";
    import {execSync} from "child_process";
    process.stdout.write(execSync(${JSON.stringify(command)}, {encoding:"utf8",maxBuffer:1024}));
    assert.throws(()=>execSync("git diff ${base}...${"f".repeat(40)}",{encoding:"utf8",maxBuffer:1024}),
      error=>error.status!==0&&String(error.stderr).includes("fatal"));
    assert.throws(()=>execSync(${JSON.stringify(`"${process.execPath}" -e "process.stdout.write('a'.repeat(10000))"`)},
      {maxBuffer:1024}),error=>error.code==="ENOBUFS");`);
  const original = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf8" });
  assert.notEqual(original.status, 0);
  assert.match(original.stderr, /ENOBUFS/);
  const repaired = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --no-warnings --import=` +
      new URL("../src/codespaces/native-review-process.mjs", import.meta.url).href } });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(repaired.stdout, expected);
});

test("native publication tolerates shared-checkout changes without weakening PR revision checks", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-review-publication-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "midgard", "packages", "review-agents", "src", "pr");
  fs.mkdirSync(directory, { recursive: true });
  const guard = `export function assertPublicationSnapshot(expected, current) {
    for (const field of [
      "pullRequestId",
      "sourceRefOid",
      "targetRefOid",
      "iteration",
      "mergeBase",
      "worktreeFingerprint",
    ] as const) {
      if (expected[field] !== current[field]) throw new Error(field + " changed");
    }
  }`;
  const file = path.join(directory, "publicationGuard.ts");
  fs.writeFileSync(file, guard);
  const other = path.join(root, "publicationGuard.ts");
  fs.writeFileSync(other, guard);
  const main = path.join(root, "verify.mjs");
  fs.writeFileSync(main, `import assert from "node:assert/strict";
    import {assertPublicationSnapshot as review} from "./midgard/packages/review-agents/src/pr/publicationGuard.ts";
    import {assertPublicationSnapshot as unrelated} from "./publicationGuard.ts";
    const saved = {pullRequestId:42,sourceRefOid:"source",targetRefOid:"target",
      iteration:1,mergeBase:"base",worktreeFingerprint:"clean"};
    review(saved,{...saved,worktreeFingerprint:"generated-file-appeared"});
    for (const field of ["pullRequestId","sourceRefOid","targetRefOid","iteration","mergeBase"])
      assert.throws(()=>review(saved,{...saved,[field]:"changed"}), new RegExp(field));
    assert.throws(()=>unrelated(saved,{...saved,worktreeFingerprint:"changed"}),/worktreeFingerprint/);`);
  const original = spawnSync(process.execPath, [main], { cwd: root, encoding: "utf8" });
  assert.notEqual(original.status, 0);
  assert.match(original.stderr, /worktreeFingerprint changed/);
  const repaired = spawnSync(process.execPath, ["--import",
    new URL("../src/codespaces/native-review-process.mjs", import.meta.url).href, main],
  { cwd: root, encoding: "utf8" });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), guard);
});

test("assigned browser access comes from the registered owner and exact original review task", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-browser-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { purpose: "review", sshHost: "review", workspace: root,
    file: path.join(root, "review.json"), remoteTools: "/workspaces/.spool-review-tools" };
  const owner = path.join(root, "owner.json");
  const registered = { version: 1, codespaceReview: config.file,
    codespaceWorkspaces: [owner], applicationAuth: { ownerConfig: owner } };
  const task = { id: "original-review", agent: "reviewer", workspace: root, prompt: "Original unchanged assignment",
    runner_metadata: { runner: "pr-reviewer", preparation: { prId: 42, sourceCommit: "a".repeat(40) } } };
  fs.mkdirSync(path.join(root, "queues", "in_progress"), { recursive: true });
  const file = path.join(root, "queues", "in_progress", task.id + ".json");
  fs.writeFileSync(file, JSON.stringify(task));
  const server = { args: ["--root", root, "--task", task.id, "--agent", task.agent] };
  const context = nativeApplicationContext(config, server, registered);
  assert.equal(context.authorization, "registered-application-owner");
  assert.equal(context.prId, 42);
  assert.equal(context.sourceCommit, "a".repeat(40));
  assert.equal(context.browser.export, "openDeployedApplicationBrowser");
  assert.deepEqual(context.browser.arguments, [config.remoteTools + "/deployed-application", {
    prId: 42, sourceCommit: "a".repeat(40), origin: "https://m365.cloud.dev.microsoft",
    url: "https://m365.cloud.dev.microsoft/chat?pr=42&enablePRWatermark=1",
  }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), task);
  for (const change of [{ codespaceReview: owner }, { applicationAuth: undefined }, { codespaceWorkspaces: [] }])
    assert.equal(nativeApplicationContext(config, server, { ...registered, ...change }), undefined);
  assert.equal(nativeApplicationContext({ ...config, purpose: "engineering" }, server, registered), undefined);
  assert.equal(nativeApplicationContext(config, { args: [...server.args.slice(0, -1), "other-agent"] }, registered), undefined);
  task.runner_metadata.preparation.sourceCommit = "not-a-revision";
  fs.writeFileSync(file, JSON.stringify(task));
  assert.equal(nativeApplicationContext(config, server, registered), undefined);
});

test("assigned browser metadata reaches the original task tool without changing prompts or other tool results", async () => {
  const application = { taskId: "original-review", authorization: "registered-application-owner" };
  const task = { id: application.taskId, prompt: "Original unchanged assignment" };
  const program = `require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
    const r=JSON.parse(line);if(r.id===undefined)return;let result;
    if(r.method==="initialize")result={protocolVersion:r.params.protocolVersion,
      capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}};
    else if(r.method==="tools/list")result={tools:[]};
    else if(r.method==="tools/call"){const task=${JSON.stringify(task)};
      if(r.params.arguments?.other)task.id="other-review";
      result={content:[{type:"text",text:JSON.stringify(task)}],structuredContent:task};}
    else result={};
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result})+"\\n");
  });`;
  const gateway = await serveMcp({ command: process.execPath, args: ["-e", program] }, {}, application);
  try {
    const url = `http://127.0.0.1:${gateway.port}/mcp`;
    const headers = { "X-API-Key": gateway.key, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream" };
    const initialized = await fetch(url, { method: "POST", headers, body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26",
        capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
    headers["Mcp-Session-Id"] = initialized.headers.get("mcp-session-id");
    await initialized.text();
    for (const [name, other, expected] of [["spool_get_task", false, { application, ...task }],
      ["spool_get_task", true, { ...task, id: "other-review" }], ["spool_update_task_status", false, task],
      ["spool_add_comment", false, task]]) {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { other } } }) });
      const body = await response.text();
      const message = response.headers.get("content-type")?.includes("text/event-stream")
        ? JSON.parse(body.split(/\r?\n/).find(line => line.startsWith("data: ")).slice(6)) : JSON.parse(body);
      assert.deepEqual(JSON.parse(message.result.content[0].text), expected);
      assert.deepEqual(message.result.structuredContent, expected);
      if (name === "spool_update_task_status")
        assert.deepEqual(JSON.parse(message.result.content[1].text), { application });
      else assert.equal(message.result.content.length, 1);
    }
  } finally { await gateway.close(); }
});

for (const purpose of ["review", "engineering"])
test(`native ${purpose} startup installs its own Azure bridge for owned and borrowed continuations`, async t => {
  for (const borrowed of [false, true]) {
    await t.test(borrowed ? "borrowed runner lease" : "original-session retry", async () => {
      const calls = [], owner = borrowed ? { token: "fixture-lease" } : undefined;
      const config = { purpose, remoteTools: "/workspaces/.spool-review-tools" };
      const transport = {
        async initialize(value) { assert.equal(value, owner); this.borrowed = borrowed; calls.push("initialize"); },
        async deploy() {
          calls.push("deploy");
          this.azureAuthFile = config.remoteTools + "/azure-auth-this-operation.json";
        },
      };
      await initializeNativeTransport(config, transport, owner);
      assert.deepEqual(calls, ["initialize", "deploy"]);
      const environment = nativeReviewEnvironment(config, transport.borrowed, transport.azureAuthFile);
      assert.match(environment, /SPOOL_REVIEW_AZURE_AUTH_FILE='\/workspaces\/\.spool-review-tools\/azure-auth-this-operation\.json'/);
      assert.match(environment, /PATH='\/workspaces\/\.spool-review-tools\/host-auth\/bin':"\$PATH"/);
    });
  }
});

test("multiline SSH startup failures remain recognizable in the native engine's last stderr line", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-startup-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, "codespace.json");
  fs.writeFileSync(profile, JSON.stringify({
    version: 1, codespace: "fixture", githubAccount: "fixture", purpose: "engineering",
    workspace: root, connector: process.execPath, nodeExecutable: process.execPath, azureCliDirectory: root,
    remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.fixture-tools", minimumFreeGiB: 1,
    nativeProfile: { repoRoot: "/workspaces/1JS", toolchainRoot: "/workspaces/1JS",
      storageRoot: "/workspaces", baseBranch: "main", nodeExecutable: "/usr/bin/node" },
  }));
  const failure = 'error getting ssh server details: failed to start SSH server:\n' +
    'Please check if an SSH server is installed.\n"features": {\n  "sshd": {}\n}\n';
  const preload = `import { CodespaceTransport } from ${JSON.stringify(new URL("../src/codespaces/transport.mjs", import.meta.url).href)};
    CodespaceTransport.prototype.initialize = async function () { throw new Error(${JSON.stringify(failure)}); };`;
  const result = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL("../src/codespaces/copilot.mjs", import.meta.url)), "--config", profile,
  ], { encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: root, USERPROFILE: root } });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(failure.trim()), "Full diagnostics must remain in the provider log");
  const lastLine = result.stderr.trim().split(/\r?\n/).at(-1);
  assert.equal(codespaceConnectionFailure(new Error(lastLine)), "ssh",
    `Native recovery must recognize the final diagnostic: ${lastLine}`);
});

test("native publication hooks reuse the Bohemia guard without blocking repository MCP or reads", () => {
  const hook = (toolName, toolArgs) => nativeToolHook({ id: "original-hook", method: "spool/preToolUse",
    params: { input: { toolName, toolArgs } } }, "/workspaces/1JS");
  for (const command of [
    "az repos pr create --repository 1JS",
    "az repos pr update --id 5935319 --description old-template",
    "curl -X PATCH https://dev.azure.com/office/Office/_apis/git/repositories/1JS/pullrequests/5935583",
  ]) {
    const response = hook("bash", { command });
    assert.equal(response.id, "original-hook");
    assert.equal(response.result.output.permissionDecision, "deny");
  }
  for (const command of ["az repos pr show --id 5935583", "git status",
    "az repos pr update --id 5935583 --squash true --auto-complete false"])
    assert.deepEqual(hook("bash", { command }).result, { output: {} });
  assert.deepEqual(hook("repository-repo_pr", { action: "update", pullRequestId: 5935583 }).result, { output: {} });
  assert.equal(nativeToolHook({ method: "session/update" }, "/workspaces/1JS"), null);
});

for (const command of ["git status", "yarn auth", "yarn build"])
test(`native shell access does not wait for background authentication: ${command}`, async () => {
  const request = { id: "local-command", method: "spool/preToolUse",
    params: { input: { toolName: "bash", toolArgs: { command } } } };
  const hook = nativeToolHook(request, "/workspaces/1JS");
  let release, response, started = false;
  const repositoryAuthentication = { ensure: () => {
    started = true;
    return new Promise(resolve => { release = resolve; });
  } };
  const pending = authenticateNativeTool(request, hook, undefined, undefined, repositoryAuthentication, value => {
    assert.equal(started, false);
    response = structuredClone(value);
  });
  assert.deepEqual(response.result.output, {});
  assert.equal(started, true);
  release();
  await pending;
});

test("background authentication failure never changes an allowed shell decision", async () => {
  const request = { id: "credential-recovery", method: "spool/preToolUse",
    params: { input: { toolName: "bash", toolArgs: { command: "yarn auth" } } } };
  const hook = nativeToolHook(request, "/workspaces/1JS"), responses = [];
  await assert.rejects(authenticateNativeTool(request, hook, undefined, undefined,
    { ensure: async () => { throw new Error("Credential broker unavailable"); } },
    value => responses.push(structuredClone(value))), /Credential broker unavailable/);
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0].result.output, {});
  assert.deepEqual(hook.result.output, {});
});

test("native PR formatting refusals are returned without starting authentication", async () => {
  const request = { id: "publication", method: "spool/preToolUse",
    params: { input: { toolName: "bash", toolArgs: {
      command: "az repos pr update --id 5935319 --description old-template",
    } } } };
  const hook = nativeToolHook(request, "/workspaces/1JS"), responses = [];
  const authentication = { ensure: async () => assert.fail("A denied command must not start authentication") };
  await authenticateNativeTool(request, hook, authentication, authentication, authentication,
    value => responses.push(value));
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.output.permissionDecision, "deny");
});

test("disconnected native sessions fail before usage collection can hang", async () => {
  let called = false;
  await assert.rejects(finishNativeSession(255, "original-session", async () => {
    called = true;
    await new Promise(() => {});
  }), /Native remote Copilot exited \(255\)/);
  assert.equal(called, false);
});

test("startup refusal before starting a lease never wakes the Codespace during disposal", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-unowned-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transport = new CodespaceTransport({ workspace: root, remoteTools: "/workspaces/.fixture-tools" });
  transport.env = {};
  let sshCalls = 0;
  transport.ssh = async () => { sshCalls++; };
  await transport.dispose();
  assert.equal(sshCalls, 0);
});

test("remote commands reuse one connection and healthy channels do not perform more rate-limited API calls", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-channel-reuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  for (const stream of ["stdin", "stdout", "stderr"]) child[stream] = new PassThrough();
  let connections = 0, checks = 0;
  const transport = new CodespaceTransport({ workspace: root, codespace: "owned" },
    { spawn: () => { connections++; return child; }, githubRequests: { directory: path.join(root, "github") } });
  transport.env = {};
  const check = transport.github.check.bind(transport.github);
  transport.github.check = codespace => { checks++; check(codespace); };
  transport.github.write("connection:owned", { until: Date.now() - 1, failures: 1, requireConnection: true });
  const calls = [];
  child.stdin.on("data", data => {
    const request = JSON.parse(data.toString());
    calls.push(request);
    child.stdout.write(JSON.stringify({ id: request.id, code: 0 }) + "\n");
  });
  const first = transport.ssh("first");
  child.stdout.write('{"ready":true}\n');
  await first;
  assert.deepEqual(transport.github.read("connection:owned"), {});
  transport.github.check = () => assert.fail("Healthy existing SSH must not request another GitHub connection");
  await transport.ssh("second");
  assert.equal(connections, 1);
  assert.equal(checks, 1);
  assert.equal(calls.length, 2);
  child.stdin.on("finish", () => child.emit("close", 0));
  await transport.dispose();
});

function coldStartup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-parallel-connect-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter(), started = [], commands = [];
  for (const stream of ["stdin", "stdout", "stderr"]) child[stream] = new PassThrough();
  child.stdin.on("data", bytes => {
    const request = JSON.parse(bytes.toString());
    if (request.shutdown) return;
    commands.push(request);
    child.stdout.write(JSON.stringify({ id: request.id, code: 0 }) + "\n");
  });
  child.stdin.on("finish", () => child.emit("close", 0));
  const transport = new CodespaceTransport({
    workspace: root, codespace: "owned", githubAccount: "fixture",
    remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.fixture-tools",
  }, { spawn: () => { started.push("commands"); return child; },
    githubRequests: { directory: path.join(root, "github") } });
  transport.environment = async () => { transport.env = {}; };
  transport.gh = async () => ({ stdout: JSON.stringify({
    state: "Available", repository: { full_name: "office-fuel/1JSBridgeRepo" },
  }) });
  const lease = path.join(root, "lease.log");
  fs.writeFileSync(lease, "");
  transport.start = (_command, _args, kind) => {
    started.push(kind);
    return { logFile: lease };
  };
  t.after(async () => {
    await transport.dispose();
    for (const stream of ["stdin", "stdout", "stderr"]) child[stream].destroy();
  });
  return { transport, child, started, commands, grant: () => fs.writeFileSync(lease, "REVIEW_LEASE_ACQUIRED") };
}

test("cold startup overlaps SSH handshakes but sends no commands or authentication before owning the lease", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = coldStartup(t);
  const initializing = f.transport.initialize();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.started, ["lease", "commands"]);
  f.child.stdout.write('{"ready":true}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.started, ["lease", "commands"]);
  f.grant();
  t.mock.timers.tick(500);
  await initializing;
  assert.deepEqual(f.started, ["lease", "commands", "authentication"]);
  assert.equal(f.commands.length, 1);
  assert.match(f.commands[0].command, /timeout 40s/);
  await f.transport.ssh("original follow-up");
  assert.equal(f.commands.length, 2);
  assert.equal(f.started.filter(value => value === "commands").length, 1);
});

test("a lease granted before SSH is ready still waits for the connection before sending commands", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = coldStartup(t);
  let ready = false;
  const initializing = f.transport.initialize().then(() => { ready = true; });
  await new Promise(resolve => setImmediate(resolve));
  f.grant();
  t.mock.timers.tick(500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false);
  assert.deepEqual(f.commands, []);
  f.child.stdout.write('{"ready":true}\n');
  await initializing;
  assert.equal(ready, true);
  assert.equal(f.commands.length, 1);
});

test("a failed speculative SSH connection refuses startup without starting repository authentication", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = coldStartup(t);
  const initializing = assert.rejects(f.transport.initialize(), /channel closed.*255/);
  await new Promise(resolve => setImmediate(resolve));
  f.child.emit("close", 255);
  t.mock.timers.tick(500);
  await initializing;
  assert.deepEqual(f.started, ["lease", "commands"]);
  assert.deepEqual(f.commands, []);
});

test("lease contention after an early SSH connection never admits repository commands", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = coldStartup(t);
  let busy = false;
  f.transport.assertChildren = () => { if (busy) throw new Error("CODESPACE_WORKSPACE_BUSY"); };
  const initializing = assert.rejects(f.transport.initialize(), /CODESPACE_WORKSPACE_BUSY/);
  await new Promise(resolve => setImmediate(resolve));
  f.child.stdout.write('{"ready":true}\n');
  busy = true;
  t.mock.timers.tick(500);
  await initializing;
  assert.deepEqual(f.started, ["lease", "commands"]);
  assert.deepEqual(f.commands, []);
});

test("a started lease still gets token-checked cleanup even if its acquisition was not acknowledged", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-owned-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transport = new CodespaceTransport({ workspace: root, remoteTools: "/workspaces/.fixture-tools" });
  transport.env = {};
  let ended = false;
  transport.children.add({ kind: "lease", exitCode: 0, stdin: { end: () => { ended = true; } } });
  const commands = [];
  transport.ssh = async command => { commands.push(command); };
  await transport.dispose();
  assert.equal(ended, true);
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes(transport.leaseToken));
});

test("a stopped Codespace gets its full SSH startup budget before the channel can expire", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codespace-start-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  for (const stream of ["stdin", "stdout", "stderr"]) child[stream] = new PassThrough();
  child.kill = () => assert.fail("Booting Codespace must not be killed after only two minutes");
  const transport = new CodespaceTransport({ workspace: root, codespace: "owned" },
    { spawn: () => child, githubRequests: { directory: path.join(root, "github") } });
  transport.env = {};
  child.stdin.on("data", bytes => {
    const request = JSON.parse(bytes.toString());
    if (request.id) child.stdout.write(JSON.stringify({ id: request.id, code: 0 }) + "\n");
  });
  const pending = transport.ssh("printf CODESPACE_CONNECTED", 300);
  t.mock.timers.tick(120001);
  child.stdout.write('{"ready":true}\n');
  await pending;
  child.stdin.on("finish", () => child.emit("close", 0));
  await transport.dispose();
});

test("successful native sessions still await verified usage collection and report its failures", async () => {
  let release, completed = false;
  const pending = new Promise(resolve => { release = resolve; });
  const finish = finishNativeSession(0, "original-session", async id => {
    assert.equal(id, "original-session");
    await pending;
  }).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  release();
  await finish;
  assert.equal(completed, true);
  await assert.rejects(finishNativeSession(0, "original-session", async () => {
    throw new Error("Usage collection failed");
  }), /Usage collection failed/);
});

test("remote CLI accepts model and task MCP settings without permission bypasses", () => {
  assert.deepEqual(remoteArguments(["--acp", "--stdio", "--log-dir", "local",
    "--model", "model", "--reasoning-effort", "high", "--additional-mcp-config",
    '{"mcpServers":{"spool":{"command":"spool"}}}']), {
    args: ["--model", "model", "--reasoning-effort", "high"], servers: { spool: { command: "spool" } },
  });
  for (const args of [["--allow-all"], ["--yolo"], ["--model"], ["--model", "--allow-all"],
    ["--log-dir"], ["--additional-mcp-config", "{"]])
    assert.throws(() => remoteArguments(args));
});

test("a restored reviewer receives the current role instead of retaining obsolete runner responsibilities", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-role-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "agents"));
  const file = path.join(root, "agents", "pr-review.md");
  fs.writeFileSync(file, "---\nmax_concurrent_runs: 1\n---\nReviewer starts the application.");
  const request = { id: 1, method: "session/prompt", params: { sessionId: "original-session",
    prompt: [{ type: "text", text: "Original assignment facts" }] } };
  const server = { args: ["--root", root, "mcp", "--agent", "pr-review", "--task", "original-task"] };
  const refreshed = withCurrentAgentRole(request, server);
  assert.equal(refreshed.params.sessionId, request.params.sessionId);
  assert.deepEqual(refreshed.params.prompt, [...request.params.prompt,
    { type: "text", text: "Reviewer starts the application." }]);
  assert.equal(request.params.prompt.length, 1);
  fs.writeFileSync(file, "Updated reviewer responsibilities.");
  assert.equal(withCurrentAgentRole(request, server).params.prompt.at(-1).text, "Updated reviewer responsibilities.");
  for (const args of [[], ["--root", root, "--agent", "../other"], ["--root", "relative", "--agent", "pr-review"]])
    assert.throws(() => withCurrentAgentRole(request, { args }), /task-bound agent role/);
});

test("engineering providers receive configured Figma and Discord without unrelated global tools", () => {
  const servers = { spool: { command: "spool" }, repository: { command: "task-repository" } };
  const configured = { repository: { command: "host-repository" },
    figma: { command: "figma", env: { FIGMA_API_KEY: "fixture" } }, discord: { command: "discord" },
    "bohemia-pr": { command: "unrelated" } };
  assert.deepEqual(nativeMcpServers(servers, configured, "engineering"),
    { spool: servers.spool, repository: configured.repository, figma: configured.figma, discord: configured.discord });
  assert.deepEqual(servers, { spool: { command: "spool" }, repository: { command: "task-repository" } });
});

test("reviewers receive configured Discord and repository without Figma or unrelated global tools", () => {
  const servers = { spool: { command: "spool" } };
  const configured = { repository: { command: "repository" }, figma: { command: "figma" },
    discord: { command: "discord", env: { DISCORD_BOT_TOKEN: "fixture" } },
    "bohemia-pr": { command: "unrelated" } };
  assert.deepEqual(nativeMcpServers(servers, configured, "review"),
    { ...servers, repository: configured.repository, discord: configured.discord });
  assert.equal(configured.discord.env.DISCORD_BOT_TOKEN, "fixture");
});

for (const purpose of ["engineering", "review"]) {
  test(`${purpose} providers preserve task Discord when no global Discord server is configured`, () => {
    const servers = { spool: { command: "spool" }, repository: { command: "repository" },
      discord: { command: "task-discord" } };
    assert.deepEqual(nativeMcpServers(servers, {}, purpose), servers);
  });
}

test("Node Figma gateways retain credentials and existing runtime options when bounding optional variables", () => {
  const figma = { command: process.execPath, args: ["figma.mjs"],
    env: { FIGMA_API_KEY: "fixture", NODE_OPTIONS: "--enable-source-maps" } };
  const selected = nativeMcpServers({}, { figma }, "engineering").figma;
  assert.equal(selected.command, figma.command);
  assert.deepEqual(selected.args, figma.args);
  assert.equal(selected.env.FIGMA_API_KEY, figma.env.FIGMA_API_KEY);
  assert.match(selected.env.NODE_OPTIONS, /^--enable-source-maps --import=file:.*\/figma-fetch\.mjs$/);
  assert.equal(figma.env.NODE_OPTIONS, "--enable-source-maps");
});

test("Figma variables timeout preserves request authentication and caller cancellation", async t => {
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    assert.equal(milliseconds, 15000);
    return timeout.signal;
  });
  const controller = new AbortController(), headers = { "X-Figma-Token": "fixture" };
  let observed;
  const fetch = withFigmaVariableTimeout(async (input, init) => { observed = { input, init }; });
  const url = "https://api.figma.com/v1/files/design/variables/local";
  await fetch(url, { headers, signal: controller.signal });
  assert.equal(observed.input, url);
  assert.equal(observed.init.headers, headers);
  assert.equal(observed.init.signal.aborted, false);
  controller.abort();
  assert.equal(observed.init.signal.aborted, true);
  assert.equal(observed.init.signal.reason, controller.signal.reason);
});

test("optional variable requests time out without changing required design requests", async t => {
  const timeout = AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  t.mock.method(AbortSignal, "timeout", () => timeout);
  const calls = [];
  const fetch = withFigmaVariableTimeout(async (input, init) => { calls.push({ input, init }); });
  await fetch(new URL("https://api.figma.com/v1/files/design/variables/local"));
  assert.equal(calls[0].init.signal.reason.name, "TimeoutError");
  const init = { headers: { "X-Figma-Token": "fixture" } };
  for (const url of ["https://api.figma.com/v1/files/design/nodes?ids=1:2",
    "https://another.example/v1/files/design/variables/local", "http://localhost:3000/library"])
    await fetch(url, init);
  assert.ok(calls.slice(1).every(call => call.init === init));
});

test("gateway requires explicit host commands", async () => {
  for (const spec of [undefined, {}, { type: "http", command: "node" }])
    await assert.rejects(serveMcp(spec), /explicit local MCP commands/);
});

test("official remote Figma reaches native Copilot unchanged instead of a local third-party gateway", async () => {
  const figma = { type: "http", url: "https://mcp.figma.com/mcp", tools: ["*"], timeout: 120000 };
  const servers = nativeMcpServers({ spool: { command: "spool" } }, { figma }, "engineering");
  assert.deepEqual(nativeRemoteMcpServers(servers), { figma });
  assert.equal(servers.figma.env, undefined);
  const gateways = new Map(), started = [];
  await startMcpGateways(servers, { fixture: "host-only" }, gateways, async (_server, _env, name) => {
    started.push(name);
    return { name };
  });
  assert.deepEqual(started, ["spool"]);
  assert.deepEqual([...gateways.keys()], ["spool"]);
  assert.deepEqual(nativeRemoteMcpServers({}), {});
  assert.throws(() => nativeRemoteMcpServers({ figma: { type: "http", url: "http://example.test/mcp" } }), /HTTPS/);
});

test("native MCP gateways start concurrently and retain their names and scoped environment", async () => {
  const servers = { spool: { command: "spool" }, repository: { command: "repository" },
    discord: { command: "discord" } };
  const environment = { REPOSITORY_CODESPACE_SESSION: "original-owner" }, gateways = new Map(), release = new Map();
  const pending = startMcpGateways(servers, environment, gateways, async (server, env, name) => {
    assert.equal(server, servers[name]);
    assert.equal(env, environment);
    await new Promise(resolve => release.set(name, resolve));
    return { name };
  });
  assert.deepEqual([...release.keys()], Object.keys(servers));
  release.get("discord")();
  release.get("spool")();
  release.get("repository")();
  await pending;
  for (const name of Object.keys(servers)) assert.equal(gateways.get(name).name, name);
});

test("failed parallel gateway startup waits for late successes so callers can clean up every child", async () => {
  const gateways = new Map(), failure = new Error("Gateway failed");
  let release, settled = false;
  const pending = startMcpGateways({ broken: {}, slow: {} }, {}, gateways, async (_server, _env, name) => {
    if (name === "broken") throw failure;
    await new Promise(resolve => { release = resolve; });
    return { name };
  });
  const rejected = assert.rejects(pending, error => { settled = true; return error === failure; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await rejected;
  assert.deepEqual([...gateways.keys()], ["slow"]);
});

test("a disconnected remote agent closes and pauses its host input instead of retaining a zombie provider", () => {
  const input = new PassThrough(), child = new EventEmitter();
  child.stdin = new PassThrough();
  const received = [];
  const incoming = relayNativeInput(input, child, line => received.push(line));
  input.write("first\n");
  assert.deepEqual(received, ["first"]);
  child.emit("close", 1);
  assert.equal(input.isPaused(), true);
  assert.equal(child.stdin.writableEnded, true);
  input.write("after-disconnect\n");
  assert.deepEqual(received, ["first"]);
  incoming.close();
  input.destroy();
  child.stdin.destroy();
});

test("private MCP gateways reject absent or incorrect API keys", async () => {
  const program = `require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
    const r=JSON.parse(line);if(r.id===undefined)return;
    const result=r.method==="initialize"?{protocolVersion:r.params.protocolVersion,
      capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}:{tools:[]};
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result})+"\\n");
  });`;
  const gateway = await serveMcp({ command: process.execPath, args: ["-e", program] });
  try {
    for (const headers of [{}, { "X-API-Key": "incorrect" }]) {
      const response = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, { headers });
      assert.equal(response.status, 401);
      await response.body.cancel();
    }
  } finally { await gateway.close(); }
});

test("native agents call review completion directly through the authenticated repository gateway", async () => {
  const program = `require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
    const r=JSON.parse(line);if(r.id===undefined)return;let result;
    if(r.method==="initialize")result={protocolVersion:r.params.protocolVersion,
      capabilities:{tools:{}},serverInfo:{name:"repository-fixture",version:"1"}};
    else if(r.method==="tools/list")result={tools:[]};
    else if(r.method==="tools/call"){
      const a=r.params.arguments;
      if(r.params.name!=="repo_pr"||a.action!=="review"||
        a.submissionId!=="assignment"||a.pullRequestId!==42||a.threadIds[0]!=="21")
        throw Error("Wrong task-bound tool request");
      result={content:[{type:"text",text:"Resolved"}],isError:false,
        structuredContent:{ready:true,resolved:["21"],result:{...a.result,transportVerified:true}}};
    }else result={};
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result})+"\\n");
  });`;
  const gateway = await serveMcp({ command: process.execPath, args: ["-e", program] });
  try {
    const url = `http://127.0.0.1:${gateway.port}/mcp`;
    const headers = { "X-API-Key": gateway.key, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream" };
    const initialized = await fetch(url, { method: "POST", headers, body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26",
        capabilities: {}, clientInfo: { name: "native-agent-test", version: "1" } } }) });
    headers["Mcp-Session-Id"] = initialized.headers.get("mcp-session-id");
    await initialized.text();
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "repo_pr", arguments: {
        action: "review", pullRequestId: 42, submissionId: "assignment", resolution: "answer",
        threadIds: ["21"], result: { submissionId: "assignment", fingerprint: "feedback", findings: [] },
      } } }) });
    const body = await response.text();
    const message = response.headers.get("content-type")?.includes("text/event-stream")
      ? JSON.parse(body.split(/\r?\n/).find(line => line.startsWith("data: ")).slice(6)) : JSON.parse(body);
    assert.equal(message.result.structuredContent.ready, true);
    assert.equal(message.result.structuredContent.result.transportVerified, true);
  } finally { await gateway.close(); }
});

function fixture(t, changes = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "native-copilot-owner-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const config = { workspace, codespace: "assigned-space", remoteRoot: "/workspaces/1JS",
    remoteTools: "/workspaces/.assigned-tools" };
  const owner = { codespace: config.codespace, root: config.remoteRoot, tools: config.remoteTools,
    token: "a".repeat(36), pid: process.pid, ...changes };
  const transport = new CodespaceTransport(config, {
    spawn: () => assert.fail("Fixtures must not open real SSH connections"),
  }), verified = [];
  transport.environment = async () => { transport.env = { REPOSITORY_CODESPACE_SESSION: JSON.stringify(owner) }; };
  transport.gh = async () => ({ stdout: '{"repository":{"full_name":"office-fuel/1JSBridgeRepo"}}' });
  transport.verifyLease = async token => { verified.push(token); };
  transport.start = () => assert.fail("Borrowed session must not replace the owner or auth broker");
  transport.ssh = async () => assert.fail("Borrowed cleanup must not signal its owner");
  return { owner, transport, verified };
}

test("repository callbacks verify and borrow their native session lease without replacing authentication", async t => {
  const { owner, transport, verified } = fixture(t);
  await transport.initialize();
  assert.deepEqual(verified, [owner.token]);
  assert.equal(transport.leaseToken, owner.token);
  await transport.dispose();
});

for (const changes of [{ codespace: "another-space" }, { root: "/workspaces/other" },
  { tools: "/workspaces/.other-tools" }, { pid: -1 }]) {
  test(`callbacks reject mismatched native ownership: ${JSON.stringify(changes)}`, async t => {
    const { transport, verified } = fixture(t, changes);
    await assert.rejects(transport.initialize(), /session owner/);
    assert.deepEqual(verified, []);
  });
}

test("an unverified remote lease cannot be borrowed", async t => {
  const { transport } = fixture(t);
  transport.verifyLease = async () => { throw new Error("Lease expired"); };
  await assert.rejects(transport.initialize(), /Lease expired/);
  assert.notEqual(transport.borrowed, true);
});

test("native startup reports the blocking stage without credentials or commands", async t => {
  const { transport } = fixture(t);
  const progress = [];
  transport.progress = message => progress.push(message);
  transport.environment = async () => { transport.env = {}; };
  transport.ssh = async () => {};
  transport.connectCommands = () => ({});
  transport.start = (_command, _args, name) => {
    const logFile = path.join(transport.config.workspace, `${name}.log`);
    fs.writeFileSync(logFile, "REVIEW_LEASE_ACQUIRED");
    return { logFile };
  };
  await transport.initialize();
  assert.deepEqual(progress, [
    "Loading host authentication",
    "Checking assigned Codespace",
    "Connecting to Codespace SSH",
    "Acquiring workspace lease",
    "Starting repository authentication",
    "Verifying repository authentication (1/20)",
  ]);
  transport.gh = async () => { throw new Error("fixture API failure"); };
  await assert.rejects(transport.initialize(), /fixture API failure/);
  assert.equal(progress.at(-1), "Checking assigned Codespace");
});

for (const state of ["Available", "Shutdown"]) {
  test(`native ${state} startup retains lease and authentication checks without redundant available-space probing`, async t => {
    const { transport } = fixture(t), calls = [];
    transport.environment = async () => { transport.env = {}; };
    transport.gh = async args => {
      if (args[1]?.endsWith("/start")) {
        assert.deepEqual(args, ["api", "user/codespaces/assigned-space/start", "--method", "POST"]);
        calls.push("start-codespace");
      }
      return { stdout: JSON.stringify({ state, repository: { full_name: "office-fuel/1JSBridgeRepo" } }) };
    };
    transport.ssh = async command => { calls.push(command); };
    transport.connectCommands = () => ({});
    transport.start = (_command, _args, name) => {
      calls.push(name);
      const logFile = path.join(transport.config.workspace, `${name}.log`);
      fs.writeFileSync(logFile, "REVIEW_LEASE_ACQUIRED");
      return { logFile };
    };
    await transport.initialize();
    assert.equal(calls.includes("printf CODESPACE_CONNECTED"), state !== "Available");
    assert.equal(calls.includes("start-codespace"), state === "Shutdown");
    if (state === "Shutdown") assert.deepEqual(calls.slice(0, 2), ["start-codespace", "printf CODESPACE_CONNECTED"]);
    assert.deepEqual(calls.slice(state === "Available" ? 0 : 2, state === "Available" ? 2 : 4),
      ["lease", "authentication"]);
    assert.match(calls.at(-1), /git .*ls-remote --exit-code origin HEAD/);
  });
}

test("an available Codespace still fails closed when lease acquisition fails", async t => {
  const { transport } = fixture(t);
  transport.environment = async () => { transport.env = {}; };
  transport.gh = async () => ({ stdout: JSON.stringify({ state: "Available",
    repository: { full_name: "office-fuel/1JSBridgeRepo" } }) });
  transport.start = (_command, _args, name) => {
    assert.equal(name, "lease");
    throw new Error("CODESPACE_WORKSPACE_BUSY");
  };
  await assert.rejects(transport.initialize(), /CODESPACE_WORKSPACE_BUSY/);
});

test("native startup refuses a shutting-down Codespace before SSH starts polling", async t => {
  const { transport, owner, verified } = fixture(t), requests = [];
  transport.gh = async args => {
    requests.push(args);
    return { stdout: JSON.stringify({ state: "ShuttingDown",
      repository: { full_name: "office-fuel/1JSBridgeRepo" } }) };
  };
  await assert.rejects(transport.initialize(), { code: "CODESPACE_SHUTTING_DOWN" });
  assert.deepEqual(requests, [["api", "user/codespaces/assigned-space"]]);
  assert.deepEqual(verified, []);
  transport.gh = async () => ({ stdout: JSON.stringify({ state: "Available",
    repository: { full_name: "office-fuel/1JSBridgeRepo" } }) });
  await transport.initialize();
  assert.deepEqual(verified, [owner.token]);
});

test("native reviewers borrow only verified runner preparation and retain its owner", async t => {
  const f = fixture(t);
  const prepared = { ownerPid: process.pid, leaseToken: f.owner.token };
  fs.writeFileSync(path.join(f.transport.config.workspace, "preparation.json"), JSON.stringify(prepared));
  let verified = false;
  const owner = await nativeSessionOwner(f.transport.config, async value => {
    assert.deepEqual(value, prepared);
    verified = true;
  });

  assert.equal(verified, true);
  assert.deepEqual(owner, f.owner);
  f.transport.environment = async () => { f.transport.env = {}; };
  await f.transport.initialize(owner);
  assert.equal(f.transport.borrowed, true);
  await f.transport.dispose();
  await assert.rejects(nativeSessionOwner(f.transport.config, async () => {
    throw new Error("Pinned PR revision changed");
  }), /Pinned PR revision changed/);
  fs.writeFileSync(path.join(f.transport.config.workspace, "preparation.json"), "{}");
  await assert.rejects(nativeSessionOwner(f.transport.config), /live runner-owned/);
  assert.equal(await nativeSessionOwner({ purpose: "engineering" }), undefined);
});

test("dashboard reviewer chat acquires its own verified lease without adopting PR preparation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = coldStartup(t), root = f.transport.config.workspace;
  const request = "11111111-2222-4333-8444-555555555555", id = `manual-${request}`;
  const agent = "pr-review", token = "fixture-provider";
  const file = path.join(root, "profile.json");
  f.transport.config.file = file;
  fs.mkdirSync(path.join(root, "queues", "in_progress"), { recursive: true });
  fs.mkdirSync(path.join(root, "controls", "ui-submissions"), { recursive: true });
  const write = (name, value) => fs.writeFileSync(name, JSON.stringify(value));
  write(file, {});
  write(path.join(root, "spool.json"), { copilotProviders: { [agent]: { args: ["--config", file] } } });
  const task = { id, agent, workspace: root, provider: { token }, interaction: { applied_requests: [request] } };
  const taskFile = path.join(root, "queues", "in_progress", `${id}.json`);
  const receiptFile = path.join(root, "controls", "ui-submissions", `${request}.json`);
  write(taskFile, task);
  write(receiptFile, { taskId: id, phase: "published", fingerprint: "a".repeat(64) });
  const server = { args: ["--root", root, "mcp", "--agent", agent, "--task", id] };
  assert.equal(nativeOperatorConversation(f.transport.config, server, token), true);
  assert.equal(nativeOperatorConversation(f.transport.config, server, "another-provider"), false);
  for (const patch of [{ agent: "another-agent" }, { workspace: path.join(root, "elsewhere") },
    { acceptance: { runner: "pr-reviewer" } }, { runner_metadata: { runner: "pr-reviewer" } },
    { runner_metadata: { runner: "manual-dashboard", preparation: { ready: true } } },
    { interaction: { applied_requests: [] } }]) {
    write(taskFile, { ...task, ...patch });
    assert.equal(nativeOperatorConversation(f.transport.config, server, token), false);
  }
  write(taskFile, task);
  write(receiptFile, { taskId: "another-task", phase: "published", fingerprint: "a".repeat(64) });
  assert.equal(nativeOperatorConversation(f.transport.config, server, token), false);
  write(receiptFile, { taskId: id, phase: "published", fingerprint: "a".repeat(64) });
  const previous = process.env.SPOOL_PROVIDER_TOKEN;
  process.env.SPOOL_PROVIDER_TOKEN = token;
  t.after(() => {
    if (previous === undefined) delete process.env.SPOOL_PROVIDER_TOKEN;
    else process.env.SPOOL_PROVIDER_TOKEN = previous;
  });
  const owner = await nativeSessionOwner(f.transport.config,
    () => assert.fail("A plain chat has no assigned PR to verify or borrow"), f.transport, server);
  assert.equal(owner, undefined);
  const initializing = f.transport.initialize(owner);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.started, ["lease", "commands"]);
  assert.deepEqual(f.commands, []);
  f.child.stdout.write('{"ready":true}\n');
  f.grant();
  t.mock.timers.tick(500);
  await initializing;
  assert.notEqual(f.transport.borrowed, true);
  assert.deepEqual(f.started, ["lease", "commands", "authentication"]);
});

test("operator continuations authenticate their original task and session without stale PR preparation", async t => {
  const f = fixture(t), root = f.transport.config.workspace;
  const id = "srun-existing-review", agent = "pr-review";
  const request = "11111111-2222-4333-8444-555555555555", session = "original-session", token = "fixture-provider";
  const file = path.join(root, "profile.json");
  f.transport.config.file = file;
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, JSON.stringify(value));
  };
  write(path.join(root, "spool.json"), { copilotProviders: { [agent]: { args: ["--config", file] } } });
  const message = { id: request, text: "Continue with direct commands.", status: "queued" };
  const task = { id, agent, workspace: root, session_id: session, provider: { token },
    runner_metadata: { runner: "pr-reviewer" },
    interaction: { applied_requests: [request], messages: [message] } };
  const taskFile = path.join(root, "queues", "in_progress", `${id}.json`);
  const commandFile = path.join(root, "controls", "commands", `${request}.json`);
  const command = { input: { id: request, kind: "message", taskId: id, message: message.text },
    request: { kind: "message", taskId: id, agent, workspace: root }, conversation: { sessionId: session } };
  write(taskFile, task);
  write(commandFile, command);
  const server = { args: ["--root", root, "mcp", "--agent", agent, "--task", id] };
  const previous = process.env.SPOOL_PROVIDER_TOKEN;
  process.env.SPOOL_PROVIDER_TOKEN = token;
  t.after(() => {
    if (previous === undefined) delete process.env.SPOOL_PROVIDER_TOKEN;
    else process.env.SPOOL_PROVIDER_TOKEN = previous;
  });
  assert.equal(nativeOperatorConversation(f.transport.config, server), true);
  assert.equal(await nativeSessionOwner(f.transport.config,
    () => assert.fail("A user continuation must not verify old PR preparation"), f.transport, server), undefined);
  assert.equal(nativeOperatorConversation(f.transport.config, server, "wrong-token"), false);
  for (const patch of [{ session_id: "another-session" }, { agent: "another-agent" },
    { workspace: path.join(root, "another-workspace") },
    { interaction: { applied_requests: [], messages: [message] } },
    { interaction: { applied_requests: [request], messages: [{ ...message, status: "delivered" }] } }]) {
    write(taskFile, { ...task, ...patch });
    assert.equal(nativeOperatorConversation(f.transport.config, server), false);
  }
  write(taskFile, task);
  for (const patch of [{ input: { ...command.input, metadata: { runner: "pr-reviewer" } } },
    { input: { ...command.input, message: "Different input" } },
    { request: { ...command.request, taskId: "another-task" } },
    { request: { ...command.request, workspace: path.join(root, "another-workspace") } }]) {
    write(commandFile, { ...command, ...patch });
    assert.equal(nativeOperatorConversation(f.transport.config, server), false);
  }
  write(commandFile, command);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  fs.writeFileSync(path.join(root, "source.txt"), "review source");
  fs.writeFileSync(path.join(root, "protected.txt"), "review file");
  git("add", "source.txt", "protected.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Review");
  const original = git("rev-parse", "HEAD");
  git("rm", "protected.txt");
  fs.writeFileSync(path.join(root, ".gitignore"), "protected.txt\n");
  fs.writeFileSync(path.join(root, "source.txt"), "unrelated source");
  git("add", "source.txt", ".gitignore");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Other review");
  const unrelated = git("rev-parse", "HEAD");
  task.runner_metadata.preparation = { commit: original };
  write(taskFile, task);
  f.transport.config.purpose = "review";
  f.transport.config.remoteRoot = root;
  f.transport.ssh = async command => {
    const result = spawnSync(process.platform === "win32"
      ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : "bash",
    ["-c", command], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return { stdout: result.stdout };
  };
  fs.writeFileSync(path.join(root, "generated.tmp"), "preserve untracked output");
  await restoreNativeReview(f.transport.config, f.transport, server);
  assert.equal(git("rev-parse", "HEAD"), original);
  assert.equal(fs.readFileSync(path.join(root, "source.txt"), "utf8"), "review source");
  assert.equal(fs.readFileSync(path.join(root, "generated.tmp"), "utf8"), "preserve untracked output");
  git("switch", "--detach", unrelated);
  fs.writeFileSync(path.join(root, "source.txt"), "preserve tracked edit");
  await assert.rejects(restoreNativeReview(f.transport.config, f.transport, server), /cannot replace tracked work/);
  assert.equal(git("rev-parse", "HEAD"), unrelated);
  assert.equal(fs.readFileSync(path.join(root, "source.txt"), "utf8"), "preserve tracked edit");
  fs.writeFileSync(path.join(root, "source.txt"), "unrelated source");
  fs.writeFileSync(path.join(root, "protected.txt"), "preserve ignored output");
  await assert.rejects(restoreNativeReview(f.transport.config, f.transport, server), /overwritten/);
  assert.equal(git("rev-parse", "HEAD"), unrelated);
  assert.equal(fs.readFileSync(path.join(root, "protected.txt"), "utf8"), "preserve ignored output");
});

test("native startup reuses its verified transport without repeating host authentication", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.transport.config.workspace, "preparation.json"),
    JSON.stringify({ ownerPid: process.pid, leaseToken: f.owner.token }));
  const owner = await nativeSessionOwner(f.transport.config, async (_prepared, options) => {
    assert.equal(options.transport, f.transport);
    f.transport.env = {};
  }, f.transport);
  f.transport.environment = async () => assert.fail("Verified startup must reuse host authentication");
  await f.transport.initialize(owner);
  assert.deepEqual(f.verified, [f.owner.token]);
  assert.equal(f.transport.borrowed, true);
});
