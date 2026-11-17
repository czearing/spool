import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execute, writeReceipt } from "../process.mjs";
import { shellQuote, sshInvocation } from "./config.mjs";
import { startAzureBroker } from "./azure-auth.mjs";
import { preparationImplementation } from "../adapters/1js-preparation-cache.mjs";
import { CodespaceRequests, codespaceConnectionFailure } from "./github-requests.mjs";
import { CommandChannel, commandServer } from "./command-channel.mjs";

const packagesRoot = fileURLToPath(new URL("../../..", import.meta.url));
const operationProfile = (config, root = config.remoteRoot) => config.purpose === "engineering"
  ? { ...config.nativeProfile, repoRoot: root, toolchainRoot: root } : config.nativeProfile;
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const prepareExecutable = 'const f=require("node:fs"),p=process.argv[1];' +
  'f.writeFileSync(p,f.readFileSync(p,"utf8").replaceAll("\\r\\n","\\n"));f.chmodSync(p,0o700);';
export const nativeExecutable = 'const f=require("node:fs"),{pathToFileURL}=require("node:url");' +
  'process.argv[2]=Buffer.from(f.readFileSync(0)).toString("base64");import(pathToFileURL(process.argv[1]).href);';
const helperSources = ["repository-mcp/src", "repository-mcp/package.json",
  "bohemia-pr-mcp/src", "bohemia-agent-tooling/src", "bohemia-agent-tooling/package.json"];
const retiredHelpers = [
  ...["artifact-build", "artifact-hash", "artifacts", "ci-baseline", "provision", "workspace", "wsl",
    "add-packages", "package-scope", "profile", "setup", "preparation", "git-auth", "pr-policy", "validation"]
    .map(name => `repository-mcp/src/adapters/library-${name}.mjs`),
  ...["compiler-errors", "process-budget", "tarball-worker"]
    .map(name => `repository-mcp/src/adapters/library-${name}.cjs`),
  "repository-mcp/src/adapters/library-process-scope.mjs", "repository-mcp/src/adapters/library.mjs",
  "repository-mcp/src/codespaces/native-environment.mjs", "repository-mcp/src/codespaces/artifacts.mjs",
  "repository-mcp/src/codespaces/creator-resolver.mjs",
  "repository-mcp/src/publication-origin.mjs",
];
export function helperInventory(root = packagesRoot) {
  const files = [];
  const visit = name => {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("Helper source redirects");
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(file).sort())
        if (!["node_modules", "test"].includes(child) && !child.includes(".test.")) visit(`${name}/${child}`);
    } else {
      const data = name.endsWith("/azure-helper.mjs")
        ? fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n") : fs.readFileSync(file);
      files.push([name, createHash("sha256").update(data).digest("hex")]);
    }
  };
  helperSources.forEach(visit);
  return files;
}
export function helperVerification(root) {
  return `const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),root=${JSON.stringify(root)};` +
    `let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{let current=false;try{` +
    `if(fs.realpathSync(root)!==root)throw Error("Helper root redirects");` +
    `current=JSON.parse(input).every(([name,hash])=>{const file=path.join(root,name);` +
    `if(fs.realpathSync(file)!==file)throw Error("Helper file redirects");` +
    `return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")===hash&&` +
    `(!name.endsWith("/azure-helper.mjs")||(fs.statSync(file).mode&0o100)!==0);})&&` +
    `${JSON.stringify(retiredHelpers)}.every(name=>!fs.existsSync(path.join(root,name)));` +
    `}catch(error){if(error.code!=="ENOENT")throw error;}` +
    `console.log(current?"REPOSITORY_HELPERS_CURRENT":"REPOSITORY_HELPERS_STALE");});`;
}
export async function pruneAbandonedGitPacks(repoRoot, unused) {
  const fs = await import("node:fs"), path = await import("node:path");
  const pack = path.join(repoRoot, ".git", "objects", "pack");
  try {
    if (fs.realpathSync(repoRoot) !== repoRoot || fs.realpathSync(pack) !== pack)
      return { removed: 0, bytes: 0 };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return { removed: 0, bytes: 0 };
    throw error;
  }
  const candidates = fs.readdirSync(pack).filter(name => /^tmp_pack_[a-zA-Z0-9]{6}$/.test(name))
    .map(name => ({ file: path.join(pack, name), stat: fs.lstatSync(path.join(pack, name)) }))
    .filter(({ file, stat }) => stat.isFile() && stat.nlink === 1 &&
      Date.now() - stat.mtimeMs >= 6 * 60 * 60 * 1000 && !fs.existsSync(`${file}.idx`));
  if (!candidates.length) return { removed: 0, bytes: 0 };
  if (!unused) {
    const { spawnSync } = await import("node:child_process");
    unused = files => spawnSync("fuser", files, { stdio: "ignore" }).status === 1;
  }
  if (!await unused(candidates.map(({ file }) => file))) return { removed: 0, bytes: 0 };
  let removed = 0, bytes = 0;
  for (const { file, stat } of candidates) {
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.nlink !== 1 || current.ino !== stat.ino ||
        current.size !== stat.size || current.mtimeMs !== stat.mtimeMs ||
        fs.existsSync(`${file}.idx`)) continue;
    fs.unlinkSync(file);
    removed++;
    bytes += stat.size;
  }
  return { removed, bytes };
}
export function leaseCommand(remoteTools, token, remoteRoot, waitSeconds = 30) {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 300)
    throw new Error("Invalid Codespace lease wait");
  const program = `printf '{"token":"${token}","pid":%s}\\n' "$$" > ${shellQuote(remoteTools + ".owner.json")}; ` +
    `echo REVIEW_LEASE_ACQUIRED; while IFS= read -r -t 60 line; do test "$line" = heartbeat || exit 1; done`;
  const checkoutLease = remoteRoot ? `${remoteRoot}/.git/repository-mcp-codespace.lease` : undefined;
  const acquire = `${checkoutLease ? `flock -w ${waitSeconds} -E 75 ${shellQuote(checkoutLease)} ` : ""}` +
    `flock -w ${waitSeconds} -E 75 ${shellQuote(remoteTools + ".lease")} bash -c ${shellQuote(program)}`;
  return `exec bash -c ${shellQuote(`${acquire}; status=$?; ` +
    `if [ "$status" -eq 75 ]; then echo "CODESPACE_WORKSPACE_BUSY: another operation owns this Codespace; retry after it finishes." >&2; fi; exit "$status"`)}`;
}

export class CodespaceTransport {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.run = dependencies.execute || execute;
    this.spawn = dependencies.spawn || spawn;
    this.github = new CodespaceRequests(config.githubAccount, { run: this.run,
      ...(dependencies.githubRequests || {}) });
    this.wait = dependencies.delay || delay;
    this.progress = dependencies.onProgress || (() => {});
    this.leaseWaitSeconds = dependencies.leaseWaitSeconds ?? 30;
    this.children = new Set();
    this.heartbeats = new Set();
    this.leaseToken = randomUUID();
    this.logRoot = path.join(config.workspace, "logs");
    fs.mkdirSync(this.logRoot, { recursive: true });
  }
  async environment() {
    const { stdout } = await this.run("gh", ["auth", "token", "--hostname", "github.com",
      "--user", this.config.githubAccount]);
    if (!stdout.trim()) throw new Error("Enterprise GitHub authentication is unavailable");
    this.env = { ...process.env, GH_TOKEN: stdout.trim(),
      PATH: [this.config.azureCliDirectory, path.dirname(this.config.nodeExecutable), process.env.PATH].join(path.delimiter) };
    const authModule = await import(pathToFileURL(path.join(path.dirname(this.config.connector), "agentsAuth.ts")).href);
    const profile = this.config.nativeProfile;
    const nodeDirectory = profile?.nodeExecutable && path.posix.dirname(path.posix.normalize(profile.nodeExecutable));
    const workspaceRuntime = profile?.storageRoot && nodeDirectory &&
      (nodeDirectory === profile.storageRoot || nodeDirectory.startsWith(`${profile.storageRoot}/`));
    this.gitEnvironment = `${workspaceRuntime ? `PATH=${shellQuote(nodeDirectory)}:"$PATH" ` : ""}` +
      `SKIP_PRE_COMMIT=1 SKIP_POST_COMMIT=1 ${authModule.gitEnvironmentCommand()}`;
    return this.env;
  }
  async initialize(sessionOwner) {
    this.progress("Loading host authentication");
    if (!this.env) await this.environment();
    this.progress(this.config.sshHost ? "Checking assigned SSH host" : "Checking assigned Codespace");
    const state = this.config.sshHost ? { state: "Available" }
      : JSON.parse((await this.gh(["api", `user/codespaces/${this.config.codespace}`])).stdout);
    if (!this.config.sshHost && state.repository?.full_name !== "office-fuel/1JSBridgeRepo")
      throw new Error("Codespace does not belong to the approved 1JS bridge repository");
    if (this.config.sshHost) {
      const { stdout } = await this.ssh(`git -C ${shellQuote(this.config.remoteRoot)} remote get-url origin`);
      if (!/^https:\/\/(?:office\.visualstudio\.com\/Office|dev\.azure\.com\/office\/Office)\/_git\/1JS\/?$/i.test(stdout.trim()))
        throw new Error("SSH workspace does not belong to the approved 1JS repository");
    }
    if (state.state === "ShuttingDown") {
      const error = new Error("Assigned Codespace is shutting down; retry the original task after it is available");
      this.github.failed(error, this.config.codespace);
      throw Object.assign(error, { code: "CODESPACE_SHUTTING_DOWN", reasonCode: "codespace_unavailable" });
    }
    if (sessionOwner || this.env.REPOSITORY_CODESPACE_SESSION) {
      const owner = sessionOwner || JSON.parse(this.env.REPOSITORY_CODESPACE_SESSION);
      if (owner.codespace !== this.config.codespace || owner.sshHost !== this.config.sshHost || owner.root !== this.config.remoteRoot ||
          owner.tools !== this.config.remoteTools || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
        throw new Error("Codespace session owner does not match this workspace");
      process.kill(owner.pid, 0);
      this.progress("Verifying existing workspace lease");
      await this.verifyLease(owner.token);
      this.leaseToken = owner.token;
      this.borrowed = true;
      return;
    }
    if (state.state === "Shutdown") {
      this.progress("Starting assigned Codespace");
      await this.gh(["api", `user/codespaces/${this.config.codespace}/start`, "--method", "POST"]);
    }
    // Available spaces prove connectivity when acquiring the lease; stopped spaces still need time to start.
    if (state.state !== "Available") {
      this.progress("Connecting to Codespace SSH");
      await this.ssh("printf CODESPACE_CONNECTED", 300);
    }
    this.progress("Acquiring workspace lease");
    const connection = sshInvocation(this.config, ["-4", "-T",
      "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      leaseCommand(this.config.remoteTools, this.leaseToken, this.config.remoteRoot, this.leaseWaitSeconds)]);
    const lease = this.start(connection.command, connection.args, "lease", true);
    // Connect without issuing commands while the independent workspace lease is acquired.
    const channel = this.connectCommands(40);
    for (let attempt = 0; ; attempt++) {
      this.assertChildren();
      if (channel.failure) throw channel.failure;
      if (fs.readFileSync(lease.logFile, "utf8").includes("REVIEW_LEASE_ACQUIRED")) break;
      if (attempt >= (this.leaseWaitSeconds + 60) * 2)
        throw new Error(`Could not acquire Codespace workspace lease; log: ${lease.logFile}`);
      await delay(500);
    }
    this.github.connected(this.config.codespace);
    const maintenance = `(${pruneAbandonedGitPacks.toString()})(${JSON.stringify(this.config.remoteRoot)})` +
      `.then(result=>{if(result.removed)console.log("Reclaimed "+(result.bytes/1024**3).toFixed(2)+` +
      `" GiB from "+result.removed+" abandoned Git temporary packs");});`;
    const reclaimed = await this.ssh(`${shellQuote(this.config.nativeProfile.nodeExecutable)} -e ${shellQuote(maintenance)}`, 120);
    if (reclaimed.stdout.trim()) this.progress(reclaimed.stdout.trim());
    this.progress("Starting repository authentication");
    const authenticated = this.start(this.config.nodeExecutable, [this.config.connector, this.config.codespace,
      ...(this.config.sshHost ? ["--ssh-host", this.config.sshHost] : []),
      "--repo-dir", this.config.remoteRoot, "--exec",
      `exec bash -c 'while IFS= read -r -t 60 line; do test "$line" = heartbeat || exit 1; done'`], "authentication", true);
    this.auth = authenticated;
    for (let attempt = 0; attempt < 20; attempt++) {
      this.progress(`Verifying repository authentication (${attempt + 1}/20)`);
      this.assertChildren();
      try {
        await this.ssh(`test -x "$HOME/ado-auth-helper" && timeout 15s yarn --version && ` +
          `timeout 15s git -C ${shellQuote(this.config.remoteRoot)} ls-remote --exit-code origin HEAD`, 40);
        return;
      } catch (error) {
        this.assertChildren();
        if (attempt === 19) throw error;
        await delay(1500);
      }
    }
  }
  async gh(args, options = {}) {
    const result = await this.github.request(args, { env: this.env, ...options });
    return result;
  }
  connectCommands(timeout = 120) {
    if (!this.commandChannel) {
      this.github.check(this.config.codespace);
      this.github.record("ssh-connect", this.config.codespace);
      const program = `(${commandServer.toString()})()`;
      const connection = sshInvocation(this.config, ["-4", "-T",
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=30", "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        `${shellQuote(this.config.nativeProfile?.nodeExecutable || "node")} -e ${shellQuote(program)}`]);
      const child = this.spawn(connection.command, connection.args,
      { env: this.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.commandChannel = new CommandChannel(child, {
        startupTimeoutMs: Math.max(120000, timeout * 1000),
        onFailure: error => this.github.failed(error, this.config.codespace),
      });
    }
    return this.commandChannel;
  }
  async ssh(command, timeout = 120, logFile, input) {
    const channel = this.connectCommands(timeout);
    const encoded = Buffer.from(command).toString("base64");
    const result = await channel.run(
      `timeout ${timeout}s env ${this.gitEnvironment || ""} bash -ec "$(printf %s ${encoded} | base64 -d)"`,
      { logFile, input });
    this.github.connected(this.config.codespace);
    return result;
  }
  start(command, args, name, heartbeat = false) {
    if (command === "gh") {
      this.github.check(this.config.codespace);
      this.github.record(name, this.config.codespace);
    }
    const logFile = path.join(this.logRoot, `${Date.now()}-${name}-${randomUUID()}.log`);
    const descriptor = fs.openSync(logFile, "wx", 0o600);
    const child = spawn(command, args, { env: this.env, windowsHide: true,
      stdio: [heartbeat ? "pipe" : "ignore", descriptor, descriptor] });
    fs.closeSync(descriptor);
    child.failure = null;
    child.on("error", error => { child.failure = error.message; });
    child.on("exit", (code, signal) => { child.failure = `exited ${code ?? signal}`; });
    if (command === "gh") child.on("close", code => {
      if (code !== 0) {
        try { this.github.failed(new Error(fs.readFileSync(logFile, "utf8")), this.config.codespace); }
        catch (error) { child.failure += `; cannot persist reconnect backoff: ${error.message}`; }
      }
    });
    if (heartbeat) {
      child.stdin.on("error", error => { child.failure = `heartbeat failed: ${error.message}`; });
      const beat = () => { if (!child.killed && child.exitCode === null) child.stdin.write("heartbeat\n"); };
      beat();
      const timer = setInterval(beat, 15000);
      this.heartbeats.add(timer);
      child.once("exit", () => { clearInterval(timer); this.heartbeats.delete(timer); });
    }
    child.logFile = logFile;
    child.kind = name;
    this.children.add(child);
    return child;
  }
  assertChildren() {
    for (const child of this.children) if (child.failure) {
      if (child.kind === "lease" && fs.readFileSync(child.logFile, "utf8").includes("CODESPACE_WORKSPACE_BUSY"))
        throw Object.assign(new Error(`Codespace workspace is busy with another operation; retry after it finishes. Log: ${child.logFile}`),
          { code: "CODESPACE_WORKSPACE_BUSY", reasonCode: "workspace_busy" });
      const diagnostic = child.kind === "lease" ? fs.readFileSync(child.logFile, "utf8") : "";
      throw new Error(`Codespace connection/runtime ${child.failure}; log: ${child.logFile}` +
        (codespaceConnectionFailure(diagnostic) ? `; ${diagnostic.trim().slice(-2000)}` : ""));
    }
  }
  async ensureHelpersCurrent() {
    const file = path.join(this.config.workspace, `tools-${randomUUID()}.tar.gz`);
    try {
      const inventory = JSON.stringify(helperInventory());
      const verified = async () => {
        const { stdout } = await this.ssh(`${shellQuote(this.config.nativeProfile.nodeExecutable)} -e ` +
          shellQuote(helperVerification(this.config.remoteTools)), 120, undefined, inventory);
        return stdout.trim() === "REPOSITORY_HELPERS_CURRENT";
      };
      if (!await verified()) {
        await this.run("tar", ["-czf", file, "-C", packagesRoot,
          "--exclude=node_modules", "--exclude=*.test.*", "--exclude=test",
          ...helperSources]);
        if (JSON.stringify(helperInventory()) !== inventory) throw new Error("Helper source changed during deployment");
        await this.ssh(`mkdir -p ${shellQuote(this.config.remoteTools)}\n` +
          `test "$(realpath ${shellQuote(this.config.remoteTools)})" = ${shellQuote(this.config.remoteTools)}`);
        await this.ssh(`tar -xzf - -C ${shellQuote(this.config.remoteTools)}`, 120, undefined, fs.readFileSync(file));
        const prune = `const fs=require("node:fs"),path=require("node:path"),root=${JSON.stringify(this.config.remoteTools)};` +
          `for(const name of ${JSON.stringify(retiredHelpers)}){const file=path.join(root,name);` +
          `if(fs.realpathSync(path.dirname(file))!==path.dirname(file))throw Error("Helper directory redirects");` +
          `fs.rmSync(file,{force:true});}`;
        await this.ssh(`${shellQuote(this.config.nativeProfile.nodeExecutable)} -e ${shellQuote(prune)}`, 30);
        await this.ssh(`node -e ${shellQuote(prepareExecutable)} ` +
          shellQuote(this.config.remoteTools + "/repository-mcp/src/codespaces/azure-helper.mjs"));
        if (!await verified()) throw new Error("Deployed repository helpers failed content verification");
        this.progress("Repository helpers deployed and verified");
      } else {
        this.progress("Reusing verified unchanged repository helpers");
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  async deploy() {
    await this.ensureHelpersCurrent();
    this.azureBroker = await startAzureBroker(this.config, { execute: this.run,
      refreshPreview: target => {
        if (!this.deployedAuthentication) throw new Error("Managed preview sign-in is not configured");
        return this.deployedAuthentication.ensure(target);
      } });
    const authenticationId = this.borrowed ? randomUUID() : this.leaseToken;
    this.azureAuthFile = `${this.config.remoteTools}/azure-auth${this.borrowed ? `-${authenticationId}` : ""}.json`;
    const socket = `/tmp/spool-review-${authenticationId}.sock`;
    this.azureAuthSocket = socket;
    const writer = `const fs=require("node:fs");let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>fs.writeFileSync(process.argv[1],s,{mode:0o600}));`;
    await this.ssh(`node -e ${shellQuote(writer)} ${shellQuote(this.azureAuthFile)}`, 30, undefined,
      Buffer.from(JSON.stringify({ socket, capability: this.azureBroker.capability })));
    const connection = sshInvocation(this.config, ["-4", "-T",
      "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindMask=0177",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-R", `${socket}:127.0.0.1:${this.azureBroker.port}`,
      `exec bash -c 'while IFS= read -r -t 60 line; do test "$line" = heartbeat || exit 1; done'`]);
    this.start(connection.command, connection.args, "azure-authentication", true);
    for (let attempt = 0; ; attempt++) {
      this.assertChildren();
      try { await this.ssh(`test -S ${shellQuote(socket)}`, 10); break; }
      catch (error) {
        if (attempt === 10) throw error;
        await delay(500);
      }
    }
  }
  async changedReviewFiles(commonCommit, sourceCommit) {
    if (![commonCommit, sourceCommit].every(value => /^[a-f0-9]{40}$/i.test(value || "")))
      throw new Error("Review comparison requires pinned commit identities");
    this.assertChildren();
    const git = `git --no-pager -C ${shellQuote(this.config.remoteRoot)}`;
    const commits = [...new Set([commonCommit, sourceCommit])];
    const fetch = (object, commit) => `${git} fetch --no-tags "$fetch_filter" ` +
      `${commit !== commonCommit ? `--negotiation-tip=${shellQuote(commonCommit)} ` : ""}origin ${object} >&2 || exit 1`;
    const ensure = commits.map(commit =>
      `if ! ${git} --no-lazy-fetch cat-file -e ${shellQuote(`${commit}^{commit}`)} 2>/dev/null; then ` +
      `${fetch(shellQuote(commit), commit)}; ` +
      `elif test "$fetch_filter" = --no-filter && ! ${git} --no-lazy-fetch cat-file -e ${shellQuote(`${commit}^{tree}`)} 2>/dev/null; then ` +
      `tree=$(${git} --no-lazy-fetch cat-file commit ${shellQuote(commit)} | sed -n '1s/^tree //p'); ` +
      `test -n "$tree" || exit 1; ${fetch('"$tree"', commit)}; fi`);
    const { stdout } = await this.ssh([
      "fetch_filter=--filter=tree:0",
      `if test "$(${git} config --get core.gvfs || true)" -gt 0 2>/dev/null; then fetch_filter=--no-filter; fi`,
      ...ensure,
      `${git} diff --no-ext-diff --no-textconv --no-renames --name-only -z ` +
      `${shellQuote(commonCommit)} ${shellQuote(sourceCommit)} --`,
    ].join("\n"), 900);
    return stdout.split("\0").filter(Boolean);
  }
  async native(operation, input, reviewFiles) {
    this.assertChildren();
    await this.ensureHelpersCurrent();
    const resultFile = `${this.config.remoteTools}/${randomUUID()}.json`;
    const request = JSON.stringify({ operation, input, profile: operationProfile(this.config, input.repoRoot),
      engineering: this.config.purpose === "engineering",
      repositoryReview: this.config.repositoryReview === true, reviewFiles,
      authFile: this.azureAuthFile, resultFile,
      remoteTools: this.config.remoteTools, leaseToken: this.leaseToken,
    });
    const entry = `${this.config.remoteTools}/repository-mcp/src/codespaces/native.mjs`;
    const logFile = path.join(this.logRoot, `${Date.now()}-${operation}-${randomUUID()}.log`);
    const timeoutSeconds = operation === "prepare" ? 21600 : 7200;
    try {
      await this.ssh(`${shellQuote(this.config.nativeProfile.nodeExecutable)} -e ${shellQuote(nativeExecutable)} ${shellQuote(entry)}`,
        timeoutSeconds, logFile, request);
    } catch (error) {
      const detail = error.message.split("\n").slice(1).join("\n").trim();
      throw new Error(`Remote ${operation} failed; log: ${logFile}${detail ? `\n${detail}` : ""}`, { cause: error });
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const { stdout } = await this.ssh(`cat ${shellQuote(resultFile)}`);
        return JSON.parse(stdout);
      } catch (error) {
        const detail = error.message.split("\n").slice(1).join("\n").trim();
        const unavailable = /^getting full codespace details: (?:error making request: received response with status code 5\d\d|HTTP 5\d\d:[^\r\n]*)$/.test(detail);
        if (!unavailable || attempt === 2) throw error;
        this.progress?.(`Codespaces temporarily unavailable; recovering completed ${operation} result (${attempt + 1}/2)`);
        await (this.wait || delay)(1000 * (attempt + 1));
      }
    }
  }
  async reusePreparation(input) {
    if (!this.borrowed) return null;
    await this.ensureHelpersCurrent();
    const root = `${this.config.remoteTools}/repository-mcp/src`;
    const program = `const fs=require("node:fs"),{pathToFileURL}=require("node:url");` +
      `(async()=>{const root=${JSON.stringify(root)},file=root+"/adapters/1js-preparation-cache.mjs";` +
      `if(!fs.existsSync(file)){console.log("null");return;}` +
      `const cache=await import(pathToFileURL(file));` +
      `if(cache.preparationImplementation?.()!==${JSON.stringify(preparationImplementation())}){console.log("null");return;}` +
      `const {repositoryProfile,REPOSITORY_REMOTE}=await import(pathToFileURL(root+"/adapters/1js-profile.mjs"));` +
      `const {repositoryGitCredentials}=await import(pathToFileURL(root+"/adapters/1js-git-auth.mjs"));` +
      `const {openCheckout}=await import(pathToFileURL(root+"/checkout.mjs"));` +
      `const {withWorkspaceLock,writeReceipt}=await import(pathToFileURL(root+"/process.mjs"));` +
      `const profile=repositoryProfile(${JSON.stringify(operationProfile(this.config, input.repoRoot))});` +
      `fs.mkdirSync(profile.stateRoot,{recursive:true});` +
      `const value=await withWorkspaceLock(profile.stateRoot,async()=>{` +
      `const checkout=await openCheckout(profile.repoRoot,{authorize:root=>repositoryGitCredentials(profile,root)});` +
      `await checkout.assertRemote(REPOSITORY_REMOTE);` +
      `const value=await cache.reuseReadyPreparation(checkout,profile,${JSON.stringify(input)});` +
      `if(value)writeReceipt(checkout.receiptPath("prepare.json"),value);return value;});` +
      `console.log(JSON.stringify(value));})().catch(error=>{console.error(error.message);process.exitCode=1;});`;
    const { stdout } = await this.ssh(`${shellQuote(this.config.nativeProfile.nodeExecutable)} -e ${shellQuote(program)}`);
    return JSON.parse(stdout);
  }
  async verifyLease(token) {
    if (typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token))
      throw new Error("Saved remote review has no valid lifecycle owner");
    const check = 'const f=require("node:fs"),o=JSON.parse(f.readFileSync(process.argv[1],"utf8"));' +
      'if(o.token!==process.argv[2])throw Error("Remote review owner changed");process.kill(o.pid,0);';
    await this.ssh(`if flock -n ${shellQuote(this.config.remoteTools + ".lease")} true; then ` +
      `echo 'Remote review lease is no longer held' >&2; exit 1; fi\n` +
      `node -e ${shellQuote(check)} ${shellQuote(this.config.remoteTools + ".owner.json")} ${shellQuote(token)}`);
  }
  async reviewAccessToken() {
    if (this.reviewToken?.expires > Date.now() + 120000) return this.reviewToken.value;
    const file = this.azureAuthFile || `${this.config.remoteTools}/azure-auth.json`;
    const helper = `${this.config.remoteTools}/repository-mcp/src/codespaces/azure-helper.mjs`;
    const { stdout } = await this.ssh(`SPOOL_REVIEW_AZURE_AUTH_FILE=${shellQuote(file)} ` +
      `${shellQuote(this.config.nativeProfile.nodeExecutable)} ${shellQuote(helper)} ` +
      "get-access-token 499b84ac-1321-427f-aa17-267ca6975798 --json", 40);
    const value = JSON.parse(stdout);
    if (typeof value.accessToken !== "string" || !value.accessToken ||
        !Number.isFinite(Number(value.expires_on)) || Number(value.expires_on) * 1000 <= Date.now() + 60000)
      throw new Error("Runner-owned review authentication is unavailable or requires renewal");
    this.reviewToken = { value: value.accessToken, expires: Number(value.expires_on) * 1000 };
    return value.accessToken;
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.heartbeats) clearInterval(timer);
    this.heartbeats.clear();
    for (const child of this.children) if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    if (this.env && !this.borrowed && [...this.children].some(child => child.kind === "lease")) {
      try {
        await this.ssh(`python3 -c ${shellQuote(
          `import json,os,signal\np="${this.config.remoteTools}.owner.json"\n` +
          `if os.path.exists(p):\n o=json.load(open(p))\n if o.get("token")=="${this.leaseToken}":\n` +
          `  try:\n   c=open("/proc/%s/cmdline"%o["pid"],"rb").read()\n` +
          `   if o["token"].encode() in c: os.kill(o["pid"],signal.SIGTERM)\n` +
          `  except (FileNotFoundError,ProcessLookupError): pass\n`)}\n`, 15);
      } catch (error) {
        this.save("cleanup-error.json", { error: error.message, time: new Date().toISOString() });
      }
    }
    for (const child of this.children) if (child.exitCode === null && !child.killed) child.kill();
    this.children.clear();
    if (this.azureBroker) { await this.azureBroker.close(); this.azureBroker = null; }
    if (this.borrowed && this.azureAuthFile) {
      try {
        const cleanup = `const fs=require("node:fs");for(const file of ` +
          `${JSON.stringify([this.azureAuthFile, this.azureAuthSocket])})fs.rmSync(file,{force:true});`;
        await this.ssh(`node -e ${shellQuote(cleanup)}`, 15);
      } catch (error) {
        this.save("cleanup-error.json", { error: error.message, time: new Date().toISOString() });
      }
    }
    if (this.commandChannel) await this.commandChannel.close();
  }
  save(name, value) { writeReceipt(path.join(this.config.workspace, name), value); }
}
