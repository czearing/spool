import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateOperation } from "../../../bohemia-pr-mcp/src/operations.mjs";
import { execute, withWorkspaceLock, writeReceipt } from "../process.mjs";
import { openCheckout } from "../checkout.mjs";
import { azureDevOps } from "../azure-devops.mjs";
import { publish } from "../publication.mjs";
import { loadDiscordEnvironment, sendPullRequestLink } from "../../../bohemia-pr-mcp/src/discord.ts";
import { callingAgent, shouldNotify } from "../../../bohemia-pr-mcp/src/identity.ts";
import { repositoryProfile, repositoryEnvironment, assertRepositoryRoot, REPOSITORY_REMOTE } from "./1js-profile.mjs";
import { ensureRepositoryNode } from "./1js-node.mjs";
import { selectedPackages, packageNames, scopedCommands, scopedValidationChecks, publicationChangeAllowed } from "./1js-packages.mjs";
import { prFields, pullRequestDraft, renderPullRequest } from "./1js-pr-policy.mjs";
import { prepareRepositoryCheckout } from "./1js-preparation.mjs";
import { reuseReadyPreparation, rememberReadyPreparation, invalidateReadyPreparation } from "./1js-preparation-cache.mjs";
import { repositoryGitCredentials } from "./1js-git-auth.mjs";
import { tools as bohemiaTools } from "../../../bohemia-pr-mcp/src/tools.ts";

export async function notifyPullRequest(input) {
  if (!shouldNotify()) return "skipped: caller is not an agent";
  loadDiscordEnvironment();
  return sendPullRequestLink({ ...input, agent: callingAgent() });
}

const common = { repoRoot: { type: "string", minLength: 1 },
  packages: { type: "array", minItems: 1, items: { type: "string", minLength: 1 },
    description: "Existing 1JS package names. Otherwise inferred from changed files; required when there are no package changes." } };
const preparationFields = Object.fromEntries(Object.entries(
  bohemiaTools.find(tool => tool.name === "bohemia_prepare").inputSchema.properties)
  .filter(([key]) => key !== "seedRoot"));
const fields = {
  prepare: { ...preparationFields,
    operation: { ...preparationFields.operation,
      description: "branch/master/setup prepare source and dependencies. Application startup remains agent-owned." },
    baseBranch: { ...preparationFields.baseBranch, default: "main" } },
  build: { ...common, target: { type: "string", enum: ["build", "bundle"] } },
  check: common,
  pr: { ...common, ...prFields, action: { type: "string", enum: ["create", "update"] } },
};
fields.pr.action.description = "Omit to create, or to update when pullRequestId is supplied.";
fields.pr.sourceBranch = { ...fields.pr.sourceBranch, description: "Defaults to the current checked-out branch. Explicit branches must match it." };

export function repositoryTools() {
  return ["prepare", "build", "check", "pr"].map(operation => ({
    operation, description: `1JS ${operation}: operates across the registered full repository using package-scoped commands only. ` +
      (operation === "pr" ? "Runs the same scoped validation as check: native Lage build, bundle, lint and typecheck for selected packages and their required upstream builds, without downstream expansion, plus package-local tests; then uses the shared Bohemia title/description format and verified image-upload/publication pipeline." :
        operation === "prepare" ? "Uses the existing branch/create/checkout/resume protections and stock yarn fast for selected packages; never installs or builds the whole repository." :
          operation === "check" ? "Runs native cached Lage build, bundle, lint and typecheck for selected packages and required upstream builds, without downstream expansion, plus fresh package-local tests." :
          "Select packages explicitly or infer them from changed files; never runs root-wide validation."),
    inputSchema: { type: "object", additionalProperties: false, required: ["repoRoot"],
      properties: fields[operation],
      ...(operation === "pr" ? { oneOf: [
        { properties: { action: { const: "create" } },
          not: { required: ["pullRequestId"] },
          required: ["category", "title", "problem", "solution", "validation", "uiChange"] },
        { properties: { action: { const: "update" } }, required: ["pullRequestId"] },
      ] } : {}) },
  }));
}

export function validateRepositoryInput(operation, input) {
  if (!fields[operation]) throw new Error("Unsupported repository operation");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Repository input must be an object");
  if (operation === "pr") input = { action: input.pullRequestId === undefined ? "create" : "update", ...input };
  if (typeof input.repoRoot !== "string" || !input.repoRoot) throw new Error("repoRoot is required");
  const unsupported = Object.keys(input).filter(key => !Object.hasOwn(fields[operation], key));
  if (unsupported.length)
    throw new Error(`Unsupported 1JS operation field: ${unsupported.join(", ")}. Remove these fields; use the advertised tool schema.`);
  for (const [key, value] of Object.entries(input)) {
    const field = fields[operation][key];
    if (field.type === "boolean" ? typeof value !== "boolean" :
      field.type === "integer" ? !Number.isSafeInteger(value) || value < 1 :
      field.type === "number" ? typeof value !== "number" || !Number.isFinite(value) :
      field.type === "array" ? !Array.isArray(value) :
      field.type === "object" ? !value || typeof value !== "object" || Array.isArray(value) :
      typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${key}`);
    if (field.enum && !field.enum.includes(value)) throw new Error(`Invalid ${key}`);
    if (field.pattern && !new RegExp(field.pattern).test(value)) throw new Error(`Invalid ${key}`);
  }
  if (input.packages !== undefined) packageNames(input.packages);
  if (input.baseBranch !== undefined && input.baseBranch !== "main") throw new Error("1JS base branch must be main");
  if (operation === "prepare") validateOperation(operation, { ...input, baseBranch: "main" });
  if (operation === "pr" && (!["create", "update"].includes(input.action) ||
      input.action === "create" && (Object.keys(prFields).filter(key =>
        ["category", "title", "problem", "solution", "validation", "uiChange"].includes(key)).some(key => input[key] === undefined)) ||
      input.action === "update" && !Number.isSafeInteger(input.pullRequestId))) {
    const required = input.action === "create" ? ["category", "title", "problem", "solution", "validation", "uiChange"]
      : ["pullRequestId"];
    throw new Error(`Invalid PR create/update input. Required for ${input.action}: ${required.join(", ")}.`);
  }
  if (operation === "pr" && input.action === "create") pullRequestDraft(input);
  return input;
}

export function repositoryAdapter(config, dependencies = {}) {
  const run = dependencies.execute || execute;
  return { id: "1js", tools: async () => repositoryTools(),
    async call(operation, input) {
      input = validateRepositoryInput(operation, input);
      let profile = repositoryProfile(config, input.repoRoot);
      assertRepositoryRoot(profile);
      fs.mkdirSync(path.join(profile.stateRoot, "command-logs"), { recursive: true });
      return withWorkspaceLock(profile.stateRoot, async () => {
        profile = await ensureRepositoryNode(profile);
        const env = repositoryEnvironment(profile);
        const checkout = await (dependencies.openCheckout || openCheckout)(profile.repoRoot,
          { run, env, authorize: root => repositoryGitCredentials(profile, root) });
        await checkout.assertRemote(REPOSITORY_REMOTE);
        if (operation === "prepare") {
          const cached = await reuseReadyPreparation(checkout, profile, input);
          if (cached) {
            writeReceipt(checkout.receiptPath("prepare.json"), cached);
            return { content: [{ type: "text", text: `1JS prepare reused verified readiness at ${cached.commit}` }],
              structuredContent: cached, isError: false };
          }
          invalidateReadyPreparation(checkout);
        }
        fs.rmSync(checkout.receiptPath(`${operation}.json`), { force: true });
        const before = await checkout.head();
        const branch = await checkout.branch();
        const invoke = async (command, args, cwd, name) => {
          const logFile = path.join(profile.stateRoot, "command-logs", `${Date.now()}-${randomUUID()}.log`);
          const commandEnv = name.endsWith(":scoped-check") ? { ...env,
              BACKFILL_MODE: env.BACKFILL_MODE ?? "READ_WRITE",
              BACKFILL_INTERNAL_CACHE_FOLDER: env.BACKFILL_INTERNAL_CACHE_FOLDER ??
                env.MIDGARD_BACKFILL_CACHE_DIR ?? path.join(profile.stateRoot, "build-cache"),
              LAGE_WRITE_REMOTE_CACHE: env.LAGE_WRITE_REMOTE_CACHE ?? "false",
            } : env;
          await run(command === "node" ? profile.nodeExecutable : command, args, { cwd, env: commandEnv, logFile });
          return { name, command, args, cwd, logFile };
        };
        if (operation === "prepare") {
          const result = await (dependencies.prepare || prepareRepositoryCheckout)(checkout, profile, input, run);
          const value = { ...result, repoRoot: profile.repoRoot };
          await rememberReadyPreparation(checkout, profile, input, value);
          writeReceipt(checkout.receiptPath("prepare.json"), value);
          return { content: [{ type: "text", text: `1JS prepare completed at ${value.commit}` }], structuredContent: value, isError: false };
        }
        let packages;
        let value;
        if (operation === "pr") {
          if (input.action === "create") input = { ...input, sourceBranch: input.sourceBranch ?? branch };
          const host = dependencies.host || azureDevOps({ organization: "https://dev.azure.com/office", project: "Office", repository: "1JS" });
          if (input.action === "update") pullRequestDraft(input, await host.get(input.pullRequestId));
          const target = input.targetBranch || (input.action === "update"
            ? (await host.get(input.pullRequestId)).targetRefName.replace(/^refs\/heads\//, "") : profile.baseBranch);
          await checkout.fetch(target);
          packages = await selectedPackages(checkout, profile, input, await checkout.changedFiles(`refs/remotes/origin/${target}`));
          value = await publish({ checkout, host, input, baseBranch: profile.baseBranch,
            allowsChange: async (file, selected) => {
              packages ||= await selectedPackages(checkout, profile, input);
              return publicationChangeAllowed(file, selected, packages);
            },
            check: () => scopedValidationChecks(packages, profile, invoke),
            policy: { draft: pullRequestDraft, render: renderPullRequest },
            notify: dependencies.notify || notifyPullRequest });
        } else {
          packages = await selectedPackages(checkout, profile, input);
          const steps = operation === "check" ? await scopedValidationChecks(packages, profile, invoke)
            : await scopedCommands(packages, input.target || "build", invoke);
          value = { ok: true, ready: true, repoRoot: profile.repoRoot, commit: await checkout.head(),
            branch: await checkout.branch(), packages: packages.map(pkg => pkg.name), steps };
        }
        if (await checkout.head() !== (operation === "pr" ? value.commit : before) || await checkout.branch() !== branch)
          throw new Error("Checkout branch or HEAD changed during the command; result is not verified");
        writeReceipt(checkout.receiptPath(`${operation}.json`), value);
        return { content: [{ type: "text", text: value.url ? `${value.title}\n${value.url}` :
          `1JS ${operation} completed for ${value.packages.join(", ")}` }], structuredContent: value, isError: false };
      });
    },
  };
}
