import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { profile } from "./sources.mjs";
import { managedParameters, handoffInstructions } from "./managed-settings.mjs";

export const agents = {
  "pr-reviewer": "pr-reviewer",
  "pr-updater": "pr-updater",
  livesite: "software-engineer",
  spelling: null,
  perf: "perf",
  ci: "ci",
  backlog: "software-engineer",
};
export const keyFor = name => name.replaceAll("-", "_");
export function configure(input, name, directory) {
  if (!Object.hasOwn(agents, name)) throw new Error(`Unknown runner: ${name}`);
  const setting = input[keyFor(name)];
  if (!setting?.enabled) throw new Error(`Runner is disabled: ${name}`);
  const isUpdater = name === "pr-updater";
  const workspace = isUpdater ? input.spool_dir : setting.workspace_dir;
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) throw new Error(`${name} requires an absolute workspace_dir`);
  if (!existsSync(workspace)) throw new Error(`${name} workspace does not exist: ${workspace}`);
  if (setting.source_dir && (!path.isAbsolute(setting.source_dir) || !existsSync(setting.source_dir))) {
    throw new Error(`${name} source_dir must name an existing absolute directory`);
  }
  if (typeof input.spool_dir !== "string" || !path.isAbsolute(input.spool_dir)) throw new Error("spool_dir must be absolute");
  const base = profile(name);
  const parameters = managedParameters(name, setting);
  const runtime = path.join(directory, ".runner");
  if (name === "spelling") {
    const interval = setting.scan_interval_seconds ?? base.pollSeconds;
    if (!Number.isSafeInteger(interval) || interval < 1) throw new Error("spelling scan interval must be positive");
    const owner = setting.agent || null;
    const publicationRoot = owner && input.agent_workspaces?.[owner];
    if (owner && (!/^[a-z0-9][a-z0-9-]*$/.test(owner) ||
        !existsSync(path.join(input.spool_dir, "agents", `${owner}.md`)) ||
        !publicationRoot || !path.isAbsolute(publicationRoot) || !existsSync(publicationRoot) ||
        !input.pr_updater?.enabled)) {
      throw new Error("Automatic spelling PRs require an existing owner, assigned checkout and native PR updater");
    }
    const ado = input.ado || {}, defaults = profile("pr-updater");
    return { config: { ...base, repoRoot: path.normalize(setting.source_dir || workspace),
      publishAgent: owner, publicationRoot: publicationRoot && path.normalize(publicationRoot),
      ado: { organization: ado.organization ? (ado.organization.startsWith("https://") ? ado.organization :
        `https://dev.azure.com/${ado.organization}`) : defaults.organization,
        project: ado.project || defaults.project, repository: ado.repository || defaults.repository,
        creatorId: ado.creator_id || defaults.creatorId },
      pollSeconds: interval, runtimeDirectory: runtime }, agent: null,
      workspace: path.normalize(setting.source_dir || workspace), runtime, interval, setting };
  }
  const agent = setting.agent || agents[name];
  if (["perf", "ci"].includes(name) && (agent !== name || handoffInstructions(setting).trim())) {
    throw new Error(`${name} discovery requires the ${name} agent and an unmodified one-sentence prompt`);
  }
  if (isUpdater && agent !== name) throw new Error("pr-updater resumes original creators; it cannot select a replacement agent");
  if (!isUpdater && (!/^[a-z0-9][a-z0-9-]*$/.test(agent) ||
      !existsSync(path.join(input.spool_dir, "agents", `${agent}.md`)))) throw new Error(`Unknown Spool agent: ${agent}`);
  const interval = setting.scan_interval_seconds ?? base.pollSeconds ?? 60;
  if (!Number.isSafeInteger(interval) || interval < 1) throw new Error(`${name} scan interval must be positive`);
  const config = {
    ...base, ...parameters, handoffInstructions: handoffInstructions(setting),
    agentId: agent, agentName: agent, assigneeAgentId: agent,
    projectId: base.projectId, paperclipProjectId: undefined, parentIssueId: null,
    repoRoot: path.normalize(setting.source_dir || workspace),
    agentWorkspaceRoot: path.normalize(workspace),
    pollSeconds: interval,
    telemetryFile: path.join(runtime, "jobs.jsonl"),
    runtimeDirectory: runtime, stateFile: path.join(runtime, "state.json"),
    workFolder: path.join(runtime, "queue"),
    requireDisposition: base.requireDisposition === true, preservePreparedBranch: false,
    transport: "spool",
  };
  for (const key of Object.keys(config)) {
    if (key.startsWith("paperclip") || key.startsWith("harness") ||
        ["creatorBindings", "creatorStateDirectory", "creatorProvenanceFile", "creatorWorkspaceRoot", "creatorWorkspaces"].includes(key)) delete config[key];
  }
  const ado = input.ado || {};
  const organization = ado.organization ? (ado.organization.startsWith("https://") ? ado.organization : `https://dev.azure.com/${ado.organization}`) : base.organization;
  const updater = profile("pr-updater");
  const identity = { creatorId: ado.creator_id || updater.creatorId,
    authorAccount: ado.author_account || updater.authorAccount,
    agentAccount: ado.author_account || updater.agentAccount };
  Object.assign(config, identity);
  config.ado = { organization: organization || updater.organization, project: ado.project || updater.project,
    repository: ado.repository || updater.repository, ...identity };
  if (name === "perf" && input.repository_profile === "1js") {
    const assigned = input.agent_workspaces?.perf;
    const providers = JSON.parse(readFileSync(path.join(input.spool_dir, "spool.json"), "utf8")).copilotProviders;
    if (ado.project !== "Office" || ado.repository !== "1JS" || !ado.project_id ||
        !ado.author_account || !ado.creator_id || !ado.organization ||
        !assigned || path.resolve(assigned).toLowerCase() !== path.resolve(workspace).toLowerCase() ||
        !providers?.perf?.command || providers.perf.workingDirectory !== "/workspaces/1JS")
      throw new Error("1JS performance requires explicit ADO identity and its assigned native provider workspace");
    Object.assign(config, { repositoryProfile: "1js", baseBranch: "main",
      legacyBranchPrefixes: ["library-production-perf-"] });
    config.ado.projectId = ado.project_id;
  }
  if (name === "backlog") {
    if (input.repository_profile !== "1js" || handoffInstructions(setting).trim() ||
        !ado.project_id ||
        !ado.author_account || !ado.creator_id || !ado.project || !ado.repository || !ado.organization)
      throw new Error("Backlog requires the 1JS profile, an exact event prompt and explicit ADO scope/identity");
    if (typeof setting.workItemProject !== "string" || !/^[\w .-]+$/.test(setting.workItemProject))
      throw new Error("Backlog requires an explicit work-item project");
    let reviewers;
    try { reviewers = JSON.parse(setting.reviewers); }
    catch { throw new Error("Backlog reviewers must be JSON name/id pairs"); }
    if (!Array.isArray(reviewers) || !reviewers.length || reviewers.some(reviewer =>
      !/^[a-f0-9-]{36}$/i.test(reviewer?.id || "") || typeof reviewer.name !== "string" ||
      !/^[\p{L}\p{N} .'-]+$/u.test(reviewer.name)) || new Set(reviewers.map(reviewer => reviewer.id.toLowerCase())).size !== reviewers.length)
      throw new Error("Backlog requires distinct explicit reviewer identities and names");
    Object.assign(config, { repositoryProfile: "1js",
      workItemProject: setting.workItemProject, reviewers });
    config.ado.projectId = ado.project_id;
  }
  if (name === "ci") {
    if (ado.project && ado.project !== updater.project && !ado.project_id)
      throw new Error("Changing the CI ADO project requires ado.project_id for draft build policies");
    config.ado.projectId = ado.project_id || updater.projectId;
  }
  if (name === "pr-reviewer") {
    config.scopes = organization && ado.project
      ? [{ organization, project: ado.project, ...(ado.repository ? { repository: ado.repository } : {}) }] : base.scopes;
    config.reviewer = setting.reviewer || ado.author_account || base.reviewer;
    if (input.codespace_review_config !== undefined) {
      if (input.repository_profile !== "1js" || ado.project !== "Office" || ado.repository !== "1JS" ||
          !path.isAbsolute(input.codespace_review_config) || !existsSync(input.codespace_review_config))
        throw new Error("Codespace review requires an existing absolute configuration and the explicit Office/1JS profile");
      config.codespaceReviewConfig = input.codespace_review_config;
      config.repositoryMcpConfig = input.repository_mcp_config;
      config.scopes = config.scopes.map(scope => ({ ...scope, repository: "1JS" }));
    }
    if (setting.directory_discovery !== undefined) {
      if (input.repository_profile !== "1js" || !config.codespaceReviewConfig ||
          !path.isAbsolute(setting.directory_discovery?.stateDirectory || ""))
        throw new Error("Directory discovery requires the registered 1JS reviewer and absolute event storage");
      config.directoryDiscovery = setting.directory_discovery;
    }
  } else {
    config.organization = organization;
    config.project = ado.project || base.project;
    config.repository = ado.repository || base.repository;
  }
  if (isUpdater) {
    config.repositoryProfile = input.repository_profile || "bohemia";
    if (!["bohemia", "1js"].includes(config.repositoryProfile)) throw new Error("Unsupported updater repository profile");
    if (config.repositoryProfile === "1js") {
      if (!path.isAbsolute(input.repository_mcp_config || "") || !existsSync(input.repository_mcp_config) ||
          !path.isAbsolute(input.repository_config_file || "") || !existsSync(input.repository_config_file))
        throw new Error("1JS updater requires existing absolute repository_mcp_config and repository_config_file");
      if (!ado.project_id || !ado.repository || !ado.project || !ado.organization)
        throw new Error("1JS updater requires explicit Azure DevOps scope and project_id");
      config.repositoryMcpConfig = input.repository_mcp_config;
      config.repositoryConfigFile = input.repository_config_file;
      delete config.appRel;
      delete config.appPort;
    }
    if (ado.project && ado.project !== base.project && !ado.project_id) {
      throw new Error("Changing the updater ADO project also requires ado.project_id for build policies");
    }
    config.projectId = ado.project_id || base.projectId;
    if (setting.task_workspace_root) throw new Error("task_workspace_root is retired; use the assigned agent workspace_dir");
    config.agentWorkspaces = { ...input.agent_workspaces };
    for (const [owner, target] of Object.entries(config.agentWorkspaces)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(owner) || typeof target !== "string" || !path.isAbsolute(target)) {
        throw new Error("agent_workspaces requires agent names mapped to absolute checkout paths");
      }
      config.agentWorkspaces[owner] = path.normalize(target);
    }
    for (const [runner, defaultAgent] of Object.entries(agents)) {
      if (runner.startsWith("pr-updater") || !defaultAgent) continue;
      const assigned = input[keyFor(runner)];
      if (!assigned?.workspace_dir) continue;
      if (!path.isAbsolute(assigned.workspace_dir)) throw new Error(`${runner} requires an absolute workspace_dir`);
      const owner = assigned.agent || defaultAgent;
      const target = path.normalize(assigned.workspace_dir);
      if (config.agentWorkspaces[owner] && config.agentWorkspaces[owner].toLowerCase() !== target.toLowerCase()) {
        throw new Error(`Conflicting assigned workspaces for ${owner}`);
      }
      config.agentWorkspaces[owner] = target;
    }
    config.shard = { index: 0, total: 1 };
    config.harnessProjectId = "spool"; // Existing evidence-key namespace; no harness transport.
  }
  return { config, agent, workspace: path.normalize(workspace), runtime, interval, setting };
}
export function readConfiguration(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
export function runnerEnvironment(input, env = process.env) {
  const config = { ...input, ado: { ...input.ado } };
  if (env.SPOOL_DIR) config.spool_dir = env.SPOOL_DIR;
  for (const [key, name] of [["organization", "ADO_ORGANIZATION"], ["project", "ADO_PROJECT"], ["repository", "ADO_REPOSITORY"]])
    if (env[name]) config.ado[key] = env[name];
  return config;
}
export function readRunnerConfiguration(entryUrl, env = process.env) {
  const config = env.SPOOL_RUNNER_CONFIG_FILE ? readConfiguration(env.SPOOL_RUNNER_CONFIG_FILE)
    : env.SPOOL_RUNNER_CONFIG ? JSON.parse(env.SPOOL_RUNNER_CONFIG)
    : readConfiguration(path.join(path.dirname(fileURLToPath(entryUrl)), "..", "..", "spool-runners.json"));
  return runnerEnvironment(config, env);
}
