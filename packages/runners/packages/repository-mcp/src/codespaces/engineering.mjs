import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readCodespaceConfig, shellQuote, isCodespaceCheckout, resolveControlWorkspace } from "./config.mjs";
import { CodespaceTransport } from "./transport.mjs";
import { validateRepositoryInput, notifyPullRequest } from "../adapters/1js.mjs";
import { publicationImages } from "../publication.mjs";
import { writeReceipt } from "../process.mjs";
import { withCodespaceWorkspaceLock } from "./recovery.mjs";
import { publicationContext, recordPublication } from "../../../bohemia-agent-tooling/src/publications.js";
import { publicationReviewers } from "../reviewers.mjs";

const configHash = config => createHash("sha256").update(fs.readFileSync(config.file)).digest("hex");
const receiptPath = config => path.join(config.workspace, "preparation.json");
function checkoutConfig(config, root = config.remoteRoot) {
  if (!isCodespaceCheckout(root))
    throw new Error("repoRoot must be an absolute checkout path in the assigned Codespace, not another workspace");
  if (root === config.remoteRoot) return config;
  if (config.purpose !== "engineering") throw new Error("Remote reviewer cannot select another workspace");
  return { ...config, remoteRoot: root,
    workspace: path.join(config.workspace, "checkouts", createHash("sha256").update(root).digest("hex")) };
}
const executionFor = config => ({ kind: "codespace", purpose: "engineering", codespace: config.codespace,
  nativeRepoRoot: config.remoteRoot, configFile: config.file, receiptFile: receiptPath(config),
  command: fileURLToPath(new URL("./run.mjs", import.meta.url)) });

export async function engineeringSnapshot(transport, config, includeWorktree = true) {
  const program = `const fs=require("node:fs"),cp=require("node:child_process"),root=${JSON.stringify(config.remoteRoot)};` +
    `if(fs.realpathSync(root)!==root)throw Error("Remote checkout redirects");` +
    `const git=(...args)=>cp.execFileSync("git",["--no-pager","-c","core.untrackedCache=false",...args],{cwd:root,encoding:"utf8"}).trim();` +
    `const snapshot={root:git("rev-parse","--show-toplevel"),commit:git("rev-parse","HEAD"),` +
    `branch:git("branch","--show-current")};` +
    (includeWorktree
      ? `const hash=require("node:crypto").createHash("sha256"),` +
        `child=cp.spawn("git",["--no-pager","-c","core.untrackedCache=false","status","--porcelain","--untracked-files=all"],{cwd:root});` +
        `let dirty=false,error="";child.stdout.on("data",chunk=>{dirty=true;hash.update(chunk);});` +
        `child.stderr.on("data",chunk=>error=(error+chunk).slice(-4096));` +
        `child.on("error",failure=>{console.error(failure);process.exitCode=1;});` +
        `child.on("close",code=>{if(code!==0){console.error(error);process.exitCode=1;return;}` +
        `snapshot.worktreeStatus=dirty?"sha256:"+hash.digest("hex"):"";console.log(JSON.stringify(snapshot));});`
      : `console.log(JSON.stringify(snapshot));`);
  const { stdout } = await transport.ssh(`${shellQuote(config.nativeProfile.nodeExecutable)} -e ${shellQuote(program)}`);
  const snapshot = JSON.parse(stdout);
  if (snapshot.root !== config.remoteRoot || !/^[a-f0-9]{40}$/i.test(snapshot.commit || "") ||
      typeof snapshot.branch !== "string" || !snapshot.branch ||
      includeWorktree && typeof snapshot.worktreeStatus !== "string")
    throw new Error("Remote engineering checkout identity could not be verified");
  return snapshot;
}

function assertReceipt(prepared, config) {
  if (!prepared?.ready) {
    const cause = prepared?.error?.match(/(?:^|\n)Error: ([^\r\n]+)/)?.[1] || prepared?.error?.split("\n")[0];
    throw new Error(`Codespace engineering preparation is not ready${cause ? `: ${cause}` : ""}`);
  }
  if (config.purpose !== "engineering" || !prepared?.ready ||
      prepared.execution?.kind !== "codespace" || prepared.execution.purpose !== "engineering" ||
      prepared.repoRoot !== config.workspace || prepared.execution.codespace !== config.codespace ||
      prepared.execution.nativeRepoRoot !== config.remoteRoot || prepared.configSha256 !== configHash(config) ||
      !prepared.nativePreparation?.ready || prepared.nativePreparation.commit !== prepared.commit ||
      prepared.nativePreparation.branch !== prepared.branch || prepared.nativePreparation.repoRoot !== config.remoteRoot)
    throw new Error("Codespace engineering preparation does not match its registered configuration");
}

export async function verifyEngineeringCodespace(prepared, options = {}) {
  const registered = options.config || readCodespaceConfig(prepared?.execution?.configFile || "");
  const config = checkoutConfig(registered, prepared?.execution?.nativeRepoRoot);
  assertReceipt(prepared, config);
  const transport = options.transport || new CodespaceTransport(registered);
  try {
    await transport.environment();
    const snapshot = await engineeringSnapshot(transport, config);
    if (snapshot.branch !== prepared.branch || !options.allowWork &&
        (snapshot.commit !== prepared.commit || !options.allowDirty && snapshot.worktreeStatus !== prepared.worktreeStatus))
      throw new Error("Prepared Codespace branch or working revision changed");
    return snapshot;
  } finally {
    if (!options.transport) await transport.dispose();
  }
}

async function stagePublicationFiles(input, transport, config) {
  const mapped = new Map();
  for (const value of Object.values(input)) {
    if (typeof value !== "string") continue;
    for (const file of publicationImages(value)) {
      if (mapped.has(file) || file.startsWith("/workspaces/")) continue;
      if (!path.isAbsolute(file) || !fs.statSync(file).isFile())
        throw new Error("PR images must be existing absolute host files or remote /workspaces files");
      const data = fs.readFileSync(file), digest = createHash("sha256").update(data).digest("hex");
      const destination = `${config.remoteTools}/publication-assets/${digest}${path.extname(file).replace(/[^a-zA-Z0-9.]/g, "")}`;
      const writer = 'const fs=require("node:fs"),path=require("node:path");let chunks=[];' +
        'process.stdin.on("data",b=>chunks.push(b));process.stdin.on("end",()=>{' +
        'const p=process.argv[1];fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.concat(chunks),{mode:0o600});});';
      await transport.ssh(`${shellQuote(config.nativeProfile.nodeExecutable)} -e ${shellQuote(writer)} ${shellQuote(destination)}`,
        120, undefined, data);
      mapped.set(file, destination);
    }
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
    typeof value === "string" ? [...mapped].reduce((text, [from, to]) => text.replaceAll(from, to), value) : value]));
}

export function withCodespaceWorkspaces(local, files, dependencies = {}) {
  if (!Array.isArray(files) || files.some(file => typeof file !== "string"))
    throw new Error("codespaceWorkspaces must contain registered configuration files");
  const readConfig = dependencies.readConfig || readCodespaceConfig;
  const configs = files.map(file => readConfig(file, { validateLocalPaths: false }));
  const review = dependencies.reviewFile ? readConfig(dependencies.reviewFile, { validateLocalPaths: false }) : null;
  if (configs.some(config => config.purpose !== "engineering") ||
      new Set(configs.map(config => config.workspace)).size !== configs.length ||
      new Set(configs.map(config => config.codespace)).size !== configs.length ||
      configs.some(config => config.workspace === review?.workspace || config.codespace === review?.codespace))
    throw new Error("Engineering Codespaces require unique control workspaces and VMs separate from the reviewer");
  const session = dependencies.session;
  const assigned = session && [...configs, ...(review ? [review] : [])].find(config => config.codespace === session.codespace &&
    config.remoteRoot === session.root && config.remoteTools === session.tools);
  if (session && !assigned) throw new Error("Remote agent has no matching registered Codespace");
  return {
    id: local.id,
    assigned: Boolean(assigned),
    tools: async () => {
      const tools = await local.tools();
      if (!assigned) return tools;
      return tools.map(tool => {
        const value = structuredClone(tool);
        value.inputSchema.required = value.inputSchema.required.filter(field => field !== "repoRoot");
        value.inputSchema.properties.repoRoot.description =
          assigned.purpose === "engineering"
            ? `Absolute source checkout in your assigned Codespace; defaults to ${assigned.remoteRoot}.`
            : `Your assigned source root ${assigned.remoteRoot}; omit to use that Codespace.`;
        return value;
      });
    },
    dispose: async () => {
      await local.dispose?.();
    },
    async call(operation, input, context) {
      let config;
      let registered;
      if (assigned) {
        config = checkoutConfig(assigned, input?.repoRoot);
        registered = assigned;
        input = { ...input, repoRoot: config.workspace };
      } else {
        const workspace = resolveControlWorkspace(input?.repoRoot);
        registered = workspace && configs.find(value => value.workspace === workspace ||
          path.dirname(workspace) === path.join(value.workspace, "checkouts"));
        if (registered) {
          config = checkoutConfig(registered, workspace === registered.workspace ? registered.remoteRoot
            : JSON.parse(fs.readFileSync(path.join(workspace, "preparation.json"), "utf8")).execution?.nativeRepoRoot);
          if (config.workspace !== workspace) throw new Error("Codespace checkout receipt belongs to a different source root");
        }
      }
      if (!config || config.purpose !== "engineering") return local.call(operation, input, context);
      readConfig(config.file);
      input = validateRepositoryInput(operation, input);
      if (operation === "prepare" && (input.operation || "branch") === "branch" &&
          (input.mode || "checkout") !== "resume")
        input = { ...input, reset: true };
      fs.mkdirSync(config.workspace, { recursive: true });
      return withCodespaceWorkspaceLock(config.workspace, async () => {
        const expectedConfig = configHash(config);
        const transport = dependencies.transport ? dependencies.transport(registered) : new CodespaceTransport(registered);
        let prepared;
        let publication;
        let reviewerSetupPending = false;
        try {
          if (operation !== "prepare") {
            prepared = JSON.parse(fs.readFileSync(receiptPath(config), "utf8"));
            assertReceipt(prepared, config);
          }
          const publisher = operation === "pr" ? publicationContext() : null;
          await transport.initialize();
          if (config.remoteRoot !== registered.remoteRoot) await engineeringSnapshot(transport, config, false);
          const cached = operation === "prepare" && transport.reusePreparation
            ? await transport.reusePreparation({ ...input, repoRoot: config.remoteRoot,
              minimumFreeGiB: Math.max(config.minimumFreeGiB, input.minimumFreeGiB || 0) }) : null;
          if (cached) {
            if (!cached.ready || cached.cached !== true || cached.buildWarmed !== true ||
                cached.repoRoot !== config.remoteRoot || !/^[a-f0-9]{40}$/i.test(cached.commit || "") ||
                !cached.branch || cached.merge?.conflicted || configHash(config) !== expectedConfig)
              throw new Error("Cached Codespace preparation did not verify readiness");
            const value = { ...cached, status: "ready", root: config.remoteRoot, worktreeStatus: "",
              repoRoot: config.workspace, execution: executionFor(config), configSha256: expectedConfig,
              nativePreparation: cached, updatedAt: new Date().toISOString() };
            writeReceipt(receiptPath(config), value);
            writeReceipt(path.join(config.workspace, "prepare.json"), value);
            return { content: [{ type: "text", text: `prepare reused verified readiness in ${config.codespace} at ${cached.commit}` }],
              structuredContent: value, isError: false };
          }
          const freeSpace = `const fs=require("node:fs"),s=fs.statfsSync(${JSON.stringify(config.remoteRoot)});` +
            `if(s.bavail*s.bsize<${config.minimumFreeGiB}*1024**3)throw Error("Insufficient remote free space");`;
          await transport.ssh(`${shellQuote(config.nativeProfile.nodeExecutable)} -e ${shellQuote(freeSpace)}`);
          const before = await engineeringSnapshot(transport, config, false);
          if (prepared && before.branch !== prepared.branch)
            throw new Error("Codespace no longer has this worker's prepared branch");
          await transport.deploy();
          if ((prepared?.merge?.setupBeforeMerge || prepared?.merge?.resumed || prepared?.merge?.conflicted) &&
              (before.commit !== prepared.commit || !prepared.merge.conflicted && !prepared.merge.resumed) &&
              prepared.conflictDependencies?.commit !== before.commit && ["build", "check", "pr"].includes(operation)) {
            const refreshed = await transport.native("prepare", {
              repoRoot: config.remoteRoot, operation: "setup", runBuild: false,
              ...(input.packages ? { packages: input.packages } : {}),
            });
            if (!refreshed.ready || refreshed.repoRoot !== config.remoteRoot ||
                refreshed.branch !== before.branch || refreshed.commit !== before.commit)
              throw new Error("Committed conflict repair dependency preparation changed its revision");
            prepared = { ...prepared, conflictDependencies: { commit: before.commit, ready: true } };
            writeReceipt(receiptPath(config), prepared);
          }
          const nativeInput = operation === "pr" ? await stagePublicationFiles(input, transport, config) : operation === "prepare"
            ? { ...input, minimumFreeGiB: Math.max(config.minimumFreeGiB, input.minimumFreeGiB || 0) } : input;
          const reviewers = operation === "pr" && dependencies.reviewerPolicy
            ? publicationReviewers(dependencies.reviewerPolicy(), () => transport.reviewAccessToken(),
              dependencies.reviewerRequest) : undefined;
          if (reviewers) {
            try { await reviewers.verify(); }
            catch (error) {
              error.stage = "reviewer_identity";
              error.nextAction = "Inspect the MCP's host-authenticated identity request and renew host login if required, " +
                "then repeat repo_pr. Do not query user entitlements or grant additional permissions.";
              throw error;
            }
          }
          const result = await transport.native(operation, { ...nativeInput, repoRoot: config.remoteRoot });
          if (!result.ready)
            throw new Error(`Remote ${operation} did not verify readiness`);
          if (result.repoRoot !== config.remoteRoot)
            throw new Error("Remote MCP result belongs to a different checkout");
          const after = await engineeringSnapshot(transport, config, operation === "prepare");
          if (configHash(config) !== expectedConfig) throw new Error("Codespace configuration changed during execution");
          if (operation === "pr" && after.branch === before.branch && after.commit !== before.commit &&
              result.attributionCleanup?.beforeCommit === before.commit && result.attributionCleanup.commit === after.commit &&
              result.commit === after.commit) {
            await transport.ssh(`git --no-pager -C ${shellQuote(config.remoteRoot)} diff --quiet ` +
              `${shellQuote(before.commit)} ${shellQuote(after.commit)} --`);
          } else if (operation !== "prepare" && after.commit !== before.commit) {
            throw new Error("Codespace changed during the MCP operation");
          }
          if (operation !== "prepare" && after.branch !== before.branch ||
              result.commit !== undefined && result.commit !== after.commit ||
              result.branch !== undefined && result.branch !== after.branch)
            throw new Error("Codespace changed during the MCP operation");
          const execution = executionFor(config);
          let value = { ...result, repoRoot: config.workspace, execution };
          if (operation === "pr") {
            publication = value;
            writeReceipt(path.join(config.workspace, "pr.json"), {
              ...value, ...(reviewers ? { ready: false, reviewerSetup: { ready: false } } : {}),
            });
            await recordPublication({ context: publisher, result, branch: after.branch, repoRoot: config.workspace });
            if (reviewers) {
              reviewerSetupPending = true;
              value.reviewerSetup = await reviewers.assign(result, await reviewers.verify(), after.branch);
              reviewerSetupPending = false;
            }
          }
          if (operation === "prepare") {
            value = { ...value, status: "ready", ...after, repoRoot: config.workspace,
              configSha256: expectedConfig, nativePreparation: result, updatedAt: new Date().toISOString() };
            writeReceipt(receiptPath(config), value);
          } else if (operation === "pr" && result.notification?.deferred === true) {
            value.notification = await (dependencies.notify || notifyPullRequest)({
              title: result.title, url: result.url, action: input.action === "create" ? "opened" : "updated",
            });
          }
          writeReceipt(path.join(config.workspace, `${operation}.json`), value);
          return { content: [{ type: "text", text: value.url
            ? `${operation} completed in ${config.codespace}: ${value.url}` +
              (value.reviewerSetup?.ready ? "\nRequired reviewers verified active and assigned; evidence is in reviewerSetup." : "")
            : `${operation} completed in ${config.codespace} at ${after.commit}${value.buildWarmed === false ? "\nBuild was not verified." : ""}` }],
          structuredContent: value, isError: false };
        } catch (error) {
          if (publication) {
            error.publication = { published: true, pullRequestId: publication.pullRequestId,
              url: publication.url, commit: publication.commit };
            error.stage = reviewerSetupPending ? "reviewer_setup" : "publication_finalization";
            error.nextAction = `PR ${publication.pullRequestId} is already published. Retry repo_pr with ` +
              `pullRequestId=${publication.pullRequestId} to finish setup; do not create a replacement PR or change permissions.`;
          }
          writeReceipt(path.join(config.workspace, `${operation}-failure.json`),
            { ready: false, error: error.message, ...(error.publication ? { publication: error.publication } : {}),
              updatedAt: new Date().toISOString() });
          if (operation === "prepare")
            writeReceipt(receiptPath(config), { ready: false, status: "blocked", error: error.message });
          throw error;
        } finally { await transport.dispose(); }
      });
    },
  };
}
