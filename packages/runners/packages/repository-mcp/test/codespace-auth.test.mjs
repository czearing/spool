import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeFeedEnvironment, startAzureBroker, REVIEW_RESOURCES, reviewCredentialResource } from "../src/codespaces/azure-auth.mjs";
import { CodespaceTransport, helperInventory, helperVerification } from "../src/codespaces/transport.mjs";
import { helperCredentials } from "../src/adapters/1js-git-auth.mjs";
import { execute } from "../src/process.mjs";
import { waitForDeployedSignIn } from "../src/codespaces/deployed-sign-in.mjs";
import { verifiedVmApplicationState, vmApplicationAuthentication } from "../src/codespaces/application-vm.mjs";
import { refreshManagedPreview, verifiedPreviewState } from "../src/codespaces/deployed-browser.mjs";

test("managed browser handoff preserves real sign-in claims without inventing KMSI", () => {
  const account = "fixture@example.invalid", now = Date.now();
  const identity = { userPrincipalName: account, objectId: "fixture-object", tenantId: "fixture-tenant" };
  const claims = { aud: "https://substrate.office.com/sydney",
    iss: "https://sts.windows.net/fixture-tenant/", oid: identity.objectId, tid: identity.tenantId,
    upn: account, exp: Math.floor(now / 1000) + 3600, signin_state: ["kmsi", "dvc_mngd"] };
  for (const origin of ["https://localhost:3000", "https://m365.cloud.dev.microsoft"]) {
    const verify = state => origin.includes("localhost") ? verifiedVmApplicationState(state, account, now) :
      verifiedPreviewState(state, { prId: 123, sourceCommit: "a".repeat(40) }, account, "PR 123 (aaaaaaa)", now);
    const make = (overrides = {}, user = identity) => {
      const token = `fixture.${Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString("base64url")}.fixture`;
      const cookie = (name, value) => ({ name, value: encodeURIComponent(JSON.stringify(value)),
        domain: new URL(origin).hostname, path: "/", secure: true });
      return { cookies: [cookie("dev-auth-UserInfo", user),
        cookie("dev-auth-AccessToken", { accessToken: "fixture-office-token", expirationTime: now + 3600000 }),
        cookie("dev-auth-SydneyToken", { accessToken: token, expirationTime: now + 3600000 })],
      origins: [{ origin, localStorage: [] }] };
    };
    const read = state => JSON.parse(decodeURIComponent(state.cookies.find(cookie => cookie.name === "dev-auth-UserInfo").value));
    const input = make();
    assert.deepEqual(read(verify(input).state).signinState, claims.signin_state);
    assert.equal(read(input).signinState, undefined, "Input state must not be mutated");
    assert.deepEqual(read(verify(make({ signin_state: ["dvc_mngd"] })).state).signinState, ["dvc_mngd"]);
    assert.deepEqual(read(verify(make({}, { ...identity, signinState: [] })).state).signinState, []);
    for (const invalid of [{ oid: "other" }, { tid: "other" }, { upn: "other@example.invalid" },
      { aud: "other" }, { iss: "https://example.invalid/" }, { exp: now / 1000 - 1 },
      { signin_state: undefined }, { signin_state: "kmsi" }, { signin_state: [true] }])
      assert.equal(read(verify(make(invalid)).state).signinState, undefined);
    const missing = make();
    missing.cookies = missing.cookies.filter(cookie => cookie.name !== "dev-auth-SydneyToken");
    assert.equal(read(verify(missing).state).signinState, undefined);
    assert.throws(() => verify(make({}, { ...identity, userPrincipalName: "other@example.invalid" })), /normal sign-in/);
  }
});

test("browser sign-in waits for exact-target host renewal without changing token permissions", async t => {
  const target = { prId: 123, sourceCommit: "a".repeat(40) };
  let release, started;
  const renewed = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const broker = await startAzureBroker({ azureCliDirectory: process.cwd() }, {
    execute: async () => ({ stdout: JSON.stringify({ accessToken: "fixture-not-a-real-token",
      expires_on: Math.floor(Date.now() / 1000) + 3600 }) }),
    refreshPreview: async actual => { assert.deepEqual(actual, target); started(); await renewed; },
  });
  t.after(() => broker.close());
  const config = { socket: { port: broker.port, host: "127.0.0.1" }, capability: broker.capability };
  let finished = false;
  const refresh = refreshManagedPreview(config, target).then(() => { finished = true; });
  await entered;
  assert.equal(finished, false);
  const token = await request(broker.port, { capability: broker.capability, resource: REVIEW_RESOURCES[0] });
  assert.equal(token.accessToken, "fixture-not-a-real-token");
  release();
  await refresh;
  assert.equal(finished, true);
  for (const invalid of [{ ...target, sourceCommit: "bad" }, { ...target, prId: -1 }]) {
    const denied = await request(broker.port, { action: "browser-refresh", capability: broker.capability, ...invalid });
    assert.ok(denied.error);
  }
  await assert.rejects(refreshManagedPreview({ ...config, capability: "not-authorized" }, target),
    /sign-in refresh failed/);
});

test("shared reviewer sign-in renews before application startup and coalesces concurrent requests", async () => {
  const config = { sshHost: "review", remoteTools: "/workspaces/.spool-review-tools", githubAccount: "fixture",
    nativeProfile: { nodeExecutable: "/usr/bin/node" } };
  const owner = { ...config, purpose: "engineering", sshHost: "owner", remoteTools: "/workspaces/.spool-owner-tools" };
  const directory = config.remoteTools + "/application-state";
  const receipt = { accountVerified: true, origin: "https://localhost:3000", stateDirectory: directory,
    storageState: directory + "/browser-state.json", expiresOn: new Date(Date.now() + 3600000).toISOString() };
  const captured = JSON.stringify({ state: {}, account: "fixture@example.invalid" });
  let renewals = 0, installs = 0, disposed = 0;
  const source = {
    async environment() {}, async verifySshRepository() {},
    async ssh(command) { assert.match(command, /ensureVmApplication/); renewals++; return { stdout: captured }; },
    async dispose() { disposed++; },
  };
  const target = { async ssh(command, timeout, options, input) {
    assert.doesNotMatch(command, /waitForApplication|healthz/);
    if (input) {
      assert.equal(input, captured);
      assert.match(command, /verifiedVmApplicationState/);
      installs++;
      return { stdout: "SHARED_VM_AUTH_READY" };
    }
    return { stdout: JSON.stringify(receipt) };
  } };
  const controller = vmApplicationAuthentication(config, target, { owner,
    createTransport: actual => { assert.equal(actual, owner); return source; } });
  await Promise.all([controller.ensure(), controller.ensure()]);
  await controller.ensure();
  assert.deepEqual({ renewals, installs, disposed }, { renewals: 1, installs: 1, disposed: 1 });
  assert.throws(() => vmApplicationAuthentication(config, target,
    { owner: { ...owner, githubAccount: "other-account" } }), /approved owner/);
});

test("managed sign-in recognizes the stock Sign in and Log In controls", async t => {
  for (const [role, label] of [["button", "Sign in"], ["button", "Log In"], ["link", "Log In"]]) {
    await t.test(`${role}: ${label}`, async () => {
      const target = { origin: "https://localhost:3000", url: "https://localhost:3000/home" };
      const captured = { verified: "fixture" };
      let url = target.origin + "/signinDev", clicks = 0;
      const locator = matched => ({
        matched,
        or(other) { return locator(matched || other.matched); },
        async count() { return matched ? 1 : 0; },
        async isVisible() { return matched; },
        async click() { assert.ok(matched); clicks++; url = target.url; },
      });
      const page = {
        url: () => url,
        getByRole: (requestedRole, { name }) => locator(requestedRole === role && name.test(label)),
      };
      const result = await waitForDeployedSignIn({ pages: () => [page] }, page, target,
        "fixture@example.invalid", { capture: async () => captured, pause: async () => {}, timeoutMs: 100 });
      assert.equal(result, captured);
      assert.equal(clicks, 1);
    });
  }
});

test("managed preview sign-in waits for navigation and document readiness before verifying", async t => {
  for (const error of [
    Object.assign(new Error("waiting for locator('body')"), { name: "TimeoutError" }),
    new Error("locator.evaluate: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('body')"),
    new Error("Execution context was destroyed, most likely because of a navigation"),
  ]) {
    await t.test(error.message, async () => {
      const target = { origin: "https://preview.example.invalid", url: "https://preview.example.invalid/chat" };
      const missing = { or() { return this; }, async count() { return 0; } };
      const page = { url: () => target.url, getByRole: () => missing };
      const verified = { accountVerified: true };
      let captures = 0;
      const result = await waitForDeployedSignIn({ pages: () => [page] }, page, target,
        "fixture@example.invalid", {
          capture: async () => { if (!captures++) throw error; return verified; },
          pause: async () => {}, timeoutMs: 1000,
        });
      assert.equal(result, verified);
      assert.equal(captures, 2);
      const failure = new Error("Browser state is not private and owned");
      await assert.rejects(waitForDeployedSignIn({ pages: () => [page] }, page, target,
        "fixture@example.invalid", { capture: async () => { throw failure; } }), error => error === failure);
    });
  }
});

test("managed remote commands inherit native commit opt-outs without changing Git hook configuration", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "native-commit-policy-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "agentsAuth.ts"),
    'export const gitEnvironmentCommand = () => "GIT_TERMINAL_PROMPT=0";\n');
  const commands = [];
  const transport = new CodespaceTransport({ workspace, githubAccount: "fixture",
    connector: path.join(workspace, "connector.mjs"), nodeExecutable: process.execPath, azureCliDirectory: workspace,
    codespace: "fixture" }, { execute: async (command, args) => {
      commands.push({ command, args });
      return { stdout: command === "gh" && args[0] === "auth" ? "fixture-token\n" : "" };
    } });
  await transport.environment();
  transport.commandChannel = { run: async command => {
    commands.push({ args: [command] });
    return { stdout: "" };
  } };
  await transport.ssh("git commit -m fixture");
  assert.match(commands.at(-1).args.at(-1), /env SKIP_PRE_COMMIT=1 SKIP_POST_COMMIT=1 GIT_TERMINAL_PROMPT=0 bash/);
  assert.doesNotMatch(transport.gitEnvironment, /hooksPath|SKIP_PRE_PUSH|SKIP_POST_CHECKOUT|SKIP_POST_MERGE/);
});

test("native Git push hooks inherit renewed feed credentials without disabling hooks", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-feed-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inherited = { ...process.env, ARTIFACTS_ACCESSTOKEN: "stale-fixture" };
  const env = await nativeFeedEnvironment(inherited, async (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.ok(args[0].endsWith("azure-helper.mjs"));
    assert.deepEqual(args.slice(1), ["get-access-token", REVIEW_RESOURCES[0]]);
    assert.equal(options.env, inherited);
    return { stdout: "renewed-fixture\n" };
  });
  assert.equal(inherited.ARTIFACTS_ACCESSTOKEN, "stale-fixture");
  const git = (args, environment = env) => execute("git", args, { cwd: root, env: environment });
  await git(["init", "--quiet"]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "--allow-empty", "-m", "Fixture"]);
  await git(["init", "--bare", "--quiet", path.join(root, "remote.git")]);
  await git(["remote", "add", "origin", path.join(root, "remote.git")]);
  const hooks = path.join(root, "hooks");
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "pre-push"),
    '#!/bin/sh\n[ "$ARTIFACTS_ACCESSTOKEN" = "renewed-fixture" ] || exit 1\n', { mode: 0o700 });
  await git(["config", "core.hooksPath", hooks.replaceAll("\\", "/")]);
  await assert.rejects(git(["push", "origin", "HEAD:refs/heads/proof"], inherited));
  await git(["push", "origin", "HEAD:refs/heads/proof"]);
  await assert.rejects(nativeFeedEnvironment(inherited, async () => ({ stdout: " \n" })), /no credential/);
  await assert.rejects(nativeFeedEnvironment(inherited, async () => { throw new Error("Broker unavailable"); }),
    /Broker unavailable/);
});

function request(port, input) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${typeof input === "string" ? input : JSON.stringify(input)}\n`));
    socket.on("data", chunk => response += chunk);
    socket.on("end", () => resolve(JSON.parse(response)));
  });
}
test("identity reads use the current borrowed operation's auth file, not a stale owner's broker", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-auth-file-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const transport = new CodespaceTransport({ workspace, remoteTools: "/workspaces/.tools",
    nativeProfile: { nodeExecutable: "/usr/bin/node" } });
  transport.azureAuthFile = "/workspaces/.tools/azure-auth-current-operation.json";
  const commands = [];
  transport.ssh = async command => {
    commands.push(command);
    return { stdout: JSON.stringify({ accessToken: "fixture-not-a-real-token",
      expires_on: Math.floor(Date.now() / 1000) + 3600 }) };
  };
  assert.equal(await transport.reviewAccessToken(), "fixture-not-a-real-token");
  assert.match(commands[0], /azure-auth-current-operation\.json/);
  assert.equal(commands[0].includes("/workspaces/.tools/azure-auth.json"), false);
  await transport.reviewAccessToken();
  assert.equal(commands.length, 1);
});
test("borrowed operations isolate authentication sockets and files while retaining the same workspace lease", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "native-auth-isolation-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const config = { workspace, remoteTools: "/workspaces/.tools", nodeExecutable: process.execPath,
    nativeProfile: { nodeExecutable: process.execPath }, azureCliDirectory: workspace };
  const create = () => {
    const commands = [], forwards = [];
    const transport = new CodespaceTransport(config, { execute: async (command, args) => {
      if (command === "tar") fs.writeFileSync(args[1], "fixture");
      else assert.ok(args.includes("get-access-token"), "Only the approved credential broker executes locally");
      return { stdout: JSON.stringify({ accessToken: "fixture-not-a-real-token",
        expires_on: Math.floor(Date.now() / 1000) + 3600 }) };
    } });
    transport.borrowed = true;
    transport.leaseToken = "a".repeat(36);
    transport.env = {};
    let uploaded = false;
    transport.ssh = async command => {
      commands.push(command);
      if (command.startsWith("tar -xzf")) uploaded = true;
      return { stdout: command.includes("REPOSITORY_HELPERS_CURRENT") && uploaded
        ? "REPOSITORY_HELPERS_CURRENT" : "" };
    };
    transport.start = (_command, args, kind) => {
      assert.equal(kind, "azure-authentication");
      forwards.push(args[args.indexOf("-R") + 1]);
    };
    return { transport, commands, forwards };
  };
  const first = create(), second = create();
  try {
    await Promise.all([first.transport.deploy(), second.transport.deploy()]);
    assert.equal(first.transport.leaseToken, second.transport.leaseToken);
    assert.notEqual(first.transport.azureAuthFile, second.transport.azureAuthFile);
    assert.notEqual(first.forwards[0].split(":")[0], second.forwards[0].split(":")[0]);
    assert.ok(first.transport.azureAuthFile.startsWith("/workspaces/.tools/azure-auth-"));
    await first.transport.dispose();
    assert.ok(first.commands.at(-1).includes(first.transport.azureAuthFile));
    assert.equal(first.commands.at(-1).includes(second.transport.azureAuthFile), false);
    const broker = second.transport.azureBroker;
    const token = await request(broker.port, { capability: broker.capability, resource: REVIEW_RESOURCES[0] });
    assert.equal(token.accessToken, "fixture-not-a-real-token");
  } finally {
    await first.transport.dispose();
    await second.transport.dispose();
  }
});
test("helper reuse verifies actual file contents and detects missing, modified and retired files", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "helper-content-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["repository-mcp", "bohemia-pr-mcp", "bohemia-agent-tooling"]) {
    fs.mkdirSync(path.join(root, name, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, name, "src", "entry.mjs"), "export const value = 1;");
    fs.writeFileSync(path.join(root, name, "package.json"), "{}");
  }
  const inventory = JSON.stringify(helperInventory(root));
  const verify = async () => (await execute(process.execPath, ["-e", helperVerification(root)],
    { input: inventory })).stdout.trim();
  assert.equal(await verify(), "REPOSITORY_HELPERS_CURRENT");
  const file = path.join(root, "repository-mcp", "src", "entry.mjs");
  fs.writeFileSync(file, "export const value = 2;");
  assert.equal(await verify(), "REPOSITORY_HELPERS_STALE");
  fs.rmSync(file);
  assert.equal(await verify(), "REPOSITORY_HELPERS_STALE");
  fs.writeFileSync(file, "export const value = 1;");
  assert.equal(await verify(), "REPOSITORY_HELPERS_CURRENT");
  const retired = path.join(root, "repository-mcp", "src", "adapters", "library.mjs");
  fs.mkdirSync(path.dirname(retired));
  fs.writeFileSync(retired, "obsolete helper");
  assert.equal(await verify(), "REPOSITORY_HELPERS_STALE");
});
test("unchanged helpers skip packaging and upload without skipping operation-isolated authentication", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "helper-deploy-reuse-")), commands = [], forwards = [];
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const transport = new CodespaceTransport({ workspace, remoteTools: "/workspaces/.tools",
    nativeProfile: { nodeExecutable: process.execPath }, azureCliDirectory: workspace },
  { execute: async (command, args) => {
    assert.notEqual(command, "tar");
    assert.ok(args.includes("get-access-token"));
    return { stdout: JSON.stringify({ accessToken: "fixture-not-a-real-token",
      expires_on: Math.floor(Date.now() / 1000) + 3600 }) };
  } });
  transport.borrowed = true;
  transport.env = {};
  transport.ssh = async command => {
    commands.push(command);
    return { stdout: command.includes("REPOSITORY_HELPERS_CURRENT") ? "REPOSITORY_HELPERS_CURRENT" : "" };
  };
  transport.start = (_command, args, kind) => {
    assert.equal(kind, "azure-authentication");
    forwards.push(args);
  };
  try {
    await transport.deploy();
    assert.equal(commands.some(command => command.startsWith("tar ")), false);
    assert.equal(commands.length, 3);
    assert.equal(forwards.length, 1);
    assert.ok(transport.azureBroker);
    assert.match(transport.azureAuthFile, /azure-auth-[a-f0-9-]+\.json$/);
  } finally { await transport.dispose(); }
});
test("failed helper content readback prevents authentication and native execution", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "helper-deploy-failure-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const transport = new CodespaceTransport({ workspace, remoteTools: "/workspaces/.tools",
    nativeProfile: { nodeExecutable: process.execPath } }, { execute: async (command, args) => {
    assert.equal(command, "tar");
    fs.writeFileSync(args[1], "fixture");
    return { stdout: "" };
  } });
  transport.ssh = async () => ({ stdout: "REPOSITORY_HELPERS_STALE" });
  await assert.rejects(transport.deploy(), /failed content verification/);
  assert.equal(transport.azureBroker, undefined);
  assert.deepEqual(fs.readdirSync(workspace), ["logs"]);
});
test("stock Codespaces cache scope uses the existing approved Storage resource only", () => {
  assert.equal(reviewCredentialResource("https://locallagecache.blob.core.windows.net/.default"),
    "https://storage.azure.com/");
  assert.equal(reviewCredentialResource("https://storage.azure.com/.default"), "https://storage.azure.com/");
  assert.equal(reviewCredentialResource("https://anotheraccount.blob.core.windows.net/.default"), undefined);
  assert.equal(reviewCredentialResource("https://graph.microsoft.com/.default"), undefined);
});
test("host resource broker authenticates only exact approved requests and caches expiring credentials", async () => {
  const calls = [];
  const broker = await startAzureBroker({ azureCliDirectory: process.cwd() }, { execute: async (_command, args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ accessToken: "fixture-not-a-real-token",
      expires_on: Math.floor(Date.now() / 1000) + 3600 }) };
  } });
  try {
    assert.equal(calls.length, REVIEW_RESOURCES.length);
    const valid = { capability: broker.capability, resource: REVIEW_RESOURCES[0] };
    const response = await request(broker.port, valid);
    assert.equal(response.accessToken, "fixture-not-a-real-token");
    for (const input of [{ ...valid, capability: "" }, { ...valid, resource: "https://graph.microsoft.com/" }, "{bad"]) {
      const denied = await request(broker.port, input);
      assert.ok(denied.error);
      assert.equal(denied.accessToken, undefined);
    }
    assert.equal(calls.length, REVIEW_RESOURCES.length);
  } finally { await broker.close(); }
});
test("missing or expired host credentials cannot start a misleading healthy broker", async () => {
  for (const response of [{}, { accessToken: "fixture", expires_on: 1 }])
    await assert.rejects(startAzureBroker({ azureCliDirectory: process.cwd() },
      { execute: async () => ({ stdout: JSON.stringify(response) }) }), /valid expiring/);
});
test("native helper authentication proves access without clearing the supported partial-clone credential helper", async () => {
  let called = false;
  const profile = { repoRoot: process.cwd(), storageRoot: process.cwd(), stateRoot: process.cwd(),
    nodeExecutable: process.execPath, packageRoot: process.cwd(), toolchainRoot: process.cwd() };
  const old = process.env.GIT_CONFIG_COUNT;
  process.env.GIT_CONFIG_COUNT = "4";
  try {
    const credentials = await helperCredentials(profile, async (command, args, options) => {
      called = true;
      assert.equal(command, "git");
      assert.deepEqual(args, ["ls-remote", "--exit-code", "origin", "HEAD"]);
      assert.equal(options.cwd, profile.repoRoot);
      assert.equal(options.env.GIT_CONFIG_COUNT, "4");
    });
    assert.equal(called, true);
    assert.equal(credentials.environment.GIT_CONFIG_COUNT, "4");
    assert.deepEqual(credentials.redactions, []);
    await assert.rejects(helperCredentials(profile, async () => { throw new Error("Authentication failed"); }),
      /Authentication failed/);
  } finally {
    if (old === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = old;
  }
});
