import fs from "node:fs";
import path from "node:path";
import { bohemiaAdapter } from "./adapters/bohemia.mjs";
import { repositoryAdapter, repositoryTools } from "./adapters/1js.mjs";
import { withCodespaceReviewer } from "./codespaces/adapter.mjs";
import { codespaceRepositoryAdapter } from "./codespaces/repository.mjs";
import { withCodespaceWorkspaces } from "./codespaces/engineering.mjs";
import { readReviewerPolicy } from "./reviewers.mjs";
import { isCodespaceCheckout } from "./codespaces/config.mjs";

export function loadAdapters(environment = process.env) {
  const adapters = [bohemiaAdapter()];
  const file = environment.REPOSITORY_MCP_CONFIG;
  if (file) {
    if (!path.isAbsolute(file)) throw new Error("REPOSITORY_MCP_CONFIG must be an absolute path");
    const config = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (config.library !== undefined)
      throw new Error("1JS local Scalar/WSL profiles are no longer supported; register Codespace control workspaces");
    const native = [config.nativeReview, config.nativeEngineering].filter(Boolean);
    const host = config.codespaceReview !== undefined || config.codespaceWorkspaces !== undefined;
    if (config.version !== 1 || native.length + Number(host) !== 1 ||
        Object.keys(config).some(key => !["version", "codespaceReview", "nativeReview",
          "nativeEngineering", "codespaceWorkspaces", "runnerConfig", "applicationAuth"].includes(key)))
      throw new Error("Invalid repository MCP configuration");
    if (config.nativeReview) {
      adapters.push(codespaceRepositoryAdapter(config.nativeReview));
      return adapters;
    }
    if (config.nativeEngineering) {
      if (process.platform !== "linux" || !isCodespaceCheckout(config.nativeEngineering.repoRoot) ||
          fs.realpathSync(config.nativeEngineering.repoRoot) !== config.nativeEngineering.repoRoot)
        throw new Error("Native Codespace engineering requires its registered Linux checkout");
      adapters.push(repositoryAdapter(config.nativeEngineering, { notify: async () => ({ deferred: true }) }));
      return adapters;
    }
    const repository = {
      id: "1js",
      tools: async () => repositoryTools(),
      call: async () => { throw new Error("1JS requires a registered Codespace control workspace; local source execution is not supported"); },
    };
    const reviewer = config.codespaceReview !== undefined
      ? withCodespaceReviewer(repository, config.codespaceReview) : repository;
    adapters.push(config.codespaceWorkspaces !== undefined
      ? withCodespaceWorkspaces(reviewer, config.codespaceWorkspaces, { reviewFile: config.codespaceReview,
        reviewerPolicy: config.runnerConfig ? () => readReviewerPolicy(config.runnerConfig) : undefined,
        session: environment.REPOSITORY_CODESPACE_SESSION ? JSON.parse(environment.REPOSITORY_CODESPACE_SESSION) : undefined }) : reviewer);
  }
  return environment.REPOSITORY_CODESPACE_SESSION ? adapters.filter(adapter => adapter.id === "1js") : adapters;
}

export async function listTools(adapters) {
  const catalogs = await Promise.all(adapters.map(async adapter => ({ adapter, tools: await adapter.tools() })));
  const operations = ["prepare", "build", "check", "pr"];
  if (adapters.length === 1 && adapters[0].assigned) {
    return operations.map(operation => {
      const tool = catalogs[0].tools.find(value => value.operation === operation);
      return { name: `repo_${operation}`, description: tool.description, inputSchema: tool.inputSchema };
    });
  }
  return operations.map(operation => ({
    name: `repo_${operation}`,
    description: `Repository ${operation}. Select a registered repo explicitly. Bohemia forwards to its unchanged MCP; 1js uses package-scoped execution across the full repository.`,
    inputSchema: {
      type: "object", required: ["repo", "input"], additionalProperties: false,
      properties: { repo: { type: "string", enum: adapters.map(adapter => adapter.id) }, input: { type: "object" } },
      oneOf: catalogs.map(({ adapter, tools }) => {
        const tool = tools.find(tool => tool.operation === operation);
        if (!tool) throw new Error(`${adapter.id} does not implement ${operation}`);
        return { properties: { repo: { const: adapter.id }, input: tool.inputSchema }, description: tool.description };
      }),
    },
  }));
}

export async function callTool(adapters, params, context = {}) {
  const { name, arguments: args } = params || {};
  if (!/^repo_(prepare|build|check|pr)$/.test(name || "")) throw new Error("Unknown repository tool");
  const assigned = adapters.length === 1 && adapters[0].assigned ? adapters[0] : undefined;
  if (assigned && (!args || !Object.hasOwn(args, "input") && !Object.hasOwn(args, "repo")))
    return assigned.call(name.slice(5), args ?? {}, context);
  if (!args || Object.keys(args).some(key => !["repo", "input"].includes(key)) ||
      !args.input || typeof args.input !== "object" || Array.isArray(args.input))
    throw new Error("Repository calls require only repo and an input object");
  const adapter = adapters.find(adapter => adapter.id === (args.repo ?? assigned?.id));
  if (!adapter) throw new Error(`Repository profile is not registered: ${args.repo}`);
  return adapter.call(name.slice(5), args.input, context);
}
