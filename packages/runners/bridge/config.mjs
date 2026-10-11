import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { profile } from "./sources.mjs";
import { managedParameters, handoffInstructions } from "./managed-settings.mjs";

export const runnerDefinitions = {
  "pr-reviewer": { agent: "pr-reviewer", repositoryUpdate: "on-demand" },
  "pr-updater": { agent: "pr-updater", repositoryUpdate: "on-demand" },
  livesite: { agent: "software-engineer", repositoryUpdate: "on-demand" },
  spelling: { agent: null, repositoryUpdate: "on-demand" },
  perf: { agent: "perf", repositoryUpdate: "on-demand" },
};
export const agents = Object.fromEntries(Object.entries(runnerDefinitions).map(([name, runner]) => [name, runner.agent]));
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
  if (name === "perf" && (agent !== "perf" || handoffInstructions(setting).trim())) {
    throw new Error("Performance discovery requires the perf agent and an unmodified one-sentence prompt");
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
    creatorRouting: false, requireDisposition: base.creatorRouting === true, preservePreparedBranch: false,
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
  if (name === "pr-reviewer") {
    config.scopes = organization && ado.project ? [{ organization, project: ado.project }] : base.scopes;
    config.reviewer = setting.reviewer || ado.author_account || base.reviewer;
  } else {
    config.organization = organization;
    config.project = ado.project || base.project;
    config.repository = ado.repository || base.repository;
  }
  if (isUpdater) {
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
