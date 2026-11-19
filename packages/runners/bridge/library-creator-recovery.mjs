import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { acquireProcessLock } from "../packages/bohemia-agent-tooling/src/index.js";
import { readJson, samePath } from "./spool-store.mjs";
import { publicationDirectory, readPublication, recordPublication } from "../packages/bohemia-agent-tooling/src/publications.js";

const sha256 = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalizedUrl = value => typeof value === "string" ? value.toLowerCase().replace(/\/+$/, "") : "";
const terminal = task => task && ["completed", "failed"].includes(task.status);

export async function recoverLibraryCreator(store, pr, client, config) {
  if (config?.repositoryProfile !== "1js") return null;
  const directory = path.join(store.records, "creator-contexts");
  if (!existsSync(directory)) return null;
  const candidates = [];
  for (const file of readdirSync(directory).filter(name => name.endsWith(".json"))) {
    const context = readJson(path.join(directory, file));
    const workspace = config.agentWorkspaces?.[context?.agent];
    if (context?.version !== 1 || context.originKind !== "spool" ||
        !workspace || !path.isAbsolute(workspace) || !existsSync(workspace) ||
        context.agent.startsWith("pr-updater") || context.agent === "pr-review" || context.agent === "pr-reviewer" ||
        file !== `${context.taskId}.json`) continue;
    const task = store.task(context.taskId);
    if (!terminal(task) || task.agent !== context.agent || !task.session_id ||
        task.session_id !== context.sessionId || task.session_config?.agent !== context.agent ||
        (context.branch && context.branch !== pr.branch)) continue;
    if (task.workspace == null ? context.workspace != null || !samePath(task.session_config.workspace, store.root) :
      !samePath(task.workspace, workspace) || !samePath(context.workspace, workspace)) continue;
    const logFile = path.join(store.root, "logs", `${task.id}.log`);
    if (!existsSync(logFile)) continue;
    const requests = new Map();
    for await (const line of createInterface({ input: createReadStream(logFile), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      const input = event.data?.arguments?.input;
      if (event.type === "tool.execution_start" && /^repository[-_]repo_pr$/.test(event.data.toolName) &&
          event.data.arguments.repo === "1js" && input?.action === "create" &&
          input.sourceBranch === pr.branch && samePath(input.repoRoot, workspace)) {
        requests.set(event.data.toolCallId, event);
      }
      const request = requests.get(event.data?.toolCallId);
      if (event.type !== "tool.execution_complete" || !request || event.data.success !== true) continue;
      const result = event.data.result?.structuredContent;
      if (result?.ok !== true || result.ready !== true || String(result.pullRequestId) !== String(pr.id) ||
          normalizedUrl(result.url) !== normalizedUrl(pr.url) || !samePath(result.repoRoot, workspace) ||
          !/^[a-f0-9]{40}$/i.test(result.commit || "") ||
          !/^[a-f0-9]{40}$/i.test(result.targetCommit || "") ||
          !["packageBuild", "productionBundle", "lint", "typecheck", "tests"]
            .every(name => result.validationScope?.verified?.[name] === true)) continue;
      candidates.push({ context, workspace, task, creationEvidence: {
        logFile, toolCallId: event.data.toolCallId, createdAt: request.timestamp, completedAt: event.timestamp,
        head: result.commit, targetCommit: result.targetCommit,
        requestSha256: sha256(request), resultSha256: sha256(event),
      } });
      break;
    }
  }
  if (!candidates.length) return null;
  if (candidates.length !== 1) throw new Error(`PR ${pr.id}: ambiguous original Library publication evidence`);
  const candidate = candidates[0];
  const fresh = await client.getPullRequest(config, pr.id, { refresh: true });
  if (fresh.status !== "active" || String(fresh.id) !== String(pr.id) || fresh.branch !== pr.branch ||
      normalizedUrl(fresh.url) !== normalizedUrl(pr.url))
    throw new Error(`PR ${pr.id}: changed during creator recovery`);
  const release = await acquireProcessLock(`${store.root}:library-creator:${pr.id}`,
    { namespace: "bohemia-pr-owner", timeoutMs: 30_000 });
  try {
    const task = store.task(candidate.task.id);
    if (!terminal(task) || task.agent !== candidate.context.agent || task.session_id !== candidate.context.sessionId ||
        sha256(readJson(path.join(directory, `${task.id}.json`))) !== sha256(candidate.context))
      throw new Error(`PR ${pr.id}: original execution context changed during creator recovery`);
    store.validateAgent(task.agent);
    const publicationRoot = store.publicationDirectory || publicationDirectory();
    const previous = readPublication(pr.url, publicationRoot);
    if (previous) return previous;
    return await recordPublication({
      context: { taskId: task.id, agent: task.agent, sessionId: task.session_id, projectRoot: store.root,
        taskWorkspace: task.workspace, originalPrompt: task.prompt, receiptDirectory: publicationRoot },
      branch: pr.branch, repoRoot: candidate.workspace,
      result: { ready: true, pullRequestId: Number(pr.id), url: pr.url,
        commit: candidate.creationEvidence.head, targetCommit: candidate.creationEvidence.targetCommit,
        ...(fresh.targetBranch ? { targetBranch: fresh.targetBranch } : {}) },
      publication: { creationEvidence: candidate.creationEvidence },
    }, { onlyIfAbsent: true });
  } finally { await release(); }
}
