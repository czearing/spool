import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { safeId, writeJson } from "./spool-store.mjs";

export function interactiveSessionOwner(store, sessionDirectory) {
  const processes = store.processes();
  for (const file of readdirSync(sessionDirectory)) {
    const match = /^inuse\.(\d+)\.lock$/.exec(file);
    if (!match) continue;
    const process = processes.find(value => Number(value.ProcessId) === Number(match[1])
      && /^(copilot|node)(\.exe)?$/i.test(value.Name));
    if (process) return Number(process.ProcessId);
  }
  return null;
}

export async function verifyInteractiveCreation({ pr, sessionDirectory, requestEventId, resultEventId }) {
  const workspace = readFileSync(path.join(sessionDirectory, "workspace.yaml"), "utf8");
  const field = name => workspace.match(new RegExp(`^${name}:\\s*([^\\r\\n]+)$`, "m"))?.[1].trim();
  const sessionId = field("id"), taskId = field("mc_task_id");
  if (!sessionId || path.basename(sessionDirectory) !== sessionId || !taskId) {
    throw new Error("Interactive creator lacks its original session/work-item identity");
  }
  safeId(taskId);
  let request, result;
  for await (const line of createInterface({ input: createReadStream(path.join(sessionDirectory, "events.jsonl")), crlfDelay: Infinity })) {
    const event = JSON.parse(line);
    if (event.id === requestEventId) request = event;
    if (event.id === resultEventId) result = event;
    if (request && result) break;
  }
  if (request?.type !== "tool.execution_start" || result?.type !== "tool.execution_complete" ||
      request.data?.toolCallId !== result.data?.toolCallId || result.data?.success !== true) {
    throw new Error("Creator recovery requires a matching successful original PR-creation tool call");
  }
  const args = request.data.arguments;
  const command = args?.command || "";
  const structuredCreate = /bohemia[_-]pr$/.test(request.data.toolName || "")
    && args?.action === "create" && args.sourceBranch === pr.branch;
  const recordedScriptCreate = request.data.toolName === "powershell"
    && /callBohemia\(['"]bohemia_pr['"]/.test(command)
    && /\baction:\s*['"]create['"]/.test(command)
    && command.match(/\bsourceBranch:\s*['"]([^'"]+)['"]/)?.[1] === pr.branch;
  const content = result.data.result?.content;
  const urls = typeof content === "string" ? content.match(/https:\/\/[^\s"'\\]+/g) || [] : [];
  const normalize = value => value.toLowerCase().replace("https://office.visualstudio.com/", "https://dev.azure.com/office/").replace(/\/+$/, "");
  if ((!structuredCreate && !recordedScriptCreate) || !urls.some(url => normalize(url) === normalize(pr.url))
      || /"isError"\s*:\s*true/.test(content || "")) {
    throw new Error("Original call does not prove creation of this exact PR and branch");
  }
  return { taskId, sessionId, sessionDirectory, requestEventId, resultEventId,
    createdAt: request.timestamp, requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    resultSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}

export async function importInteractiveCreator(store, owner) {
  const evidence = await verifyInteractiveCreation({
    pr: { branch: owner.branch, url: owner.prUrl }, ...owner.creationEvidence,
  });
  if (evidence.taskId !== owner.taskId || evidence.sessionId !== owner.sessionId ||
      evidence.requestSha256 !== owner.creationEvidence.requestSha256 ||
      evidence.resultSha256 !== owner.creationEvidence.resultSha256) {
    throw new Error("Interactive creator provenance changed; import held");
  }
  const pid = interactiveSessionOwner(store, evidence.sessionDirectory);
  if (pid) return { holding: `Verified original author is active in Copilot session ${owner.sessionId} (PID ${pid}); continuation waits without interrupting it` };
  if (store.task(owner.taskId)) return { imported: false };
  if (store.tasks().some(task => task.session_id === owner.sessionId)) {
    throw new Error("Original interactive conversation is already owned by another Spool task");
  }
  store.validateAgent(owner.agent);
  const now = new Date().toISOString();
  const task = {
    id: owner.taskId, agent: owner.agent, title: owner.title,
    prompt: "Imported original interactive work item; its existing conversation owns the PR follow-up.",
    workspace: owner.workspace, session_id: owner.sessionId, status: "failed",
    created_at: evidence.createdAt, updated_at: now, comments: [{
      author: "spool-runners", created_at: now,
      message: `Recovered original interactive work item and conversation from verified PR creation events ${evidence.requestEventId}, ${evidence.resultEventId}. No replacement conversation was created.`,
    }], turns: 0, cost: {}, error: "Original-session follow-up awaits prepared handoff",
  };
  const file = path.join(store.queues, "failed", `${safeId(task.id)}.json`);
  if (existsSync(file)) throw new Error("Interactive creator import raced an existing task");
  writeJson(path.join(store.records, `task-${task.id}.json`), {
    taskId: task.id, runner: "interactive-creator-import", creationEvidence: evidence,
  });
  writeJson(file, task);
  return { imported: true };
}
