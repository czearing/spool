import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { safeId, samePath, writeJson } from "./spool-store.mjs";

function executedScript(command, sessionDirectory) {
  const match = /(?:^|;)\s*(?:&\s*)?node(?:\.exe)?\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|>]+))(?=\s*(?:[*;>&|]|$))/i.exec(command);
  const file = match?.[1] || match?.[2] || match?.[3];
  return file && path.isAbsolute(file) && samePath(path.dirname(file), path.join(sessionDirectory, "files"))
    ? path.resolve(file) : null;
}

function scriptCreation(source, branch, ts) {
  const parsed = ts.createSourceFile("creation.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) return null;
  const imported = parsed.statements.flatMap(statement =>
    ts.isImportDeclaration(statement) && /bohemia-pr-mcp(?:\/src\/client\.mjs|\/client)$/.test(statement.moduleSpecifier.text)
      && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      ? statement.importClause.namedBindings.elements.filter(item => (item.propertyName || item.name).text === "callBohemia")
        .map(item => item.name.text) : []);
  const property = (object, name) => ts.isObjectLiteralExpression(object)
    ? object.properties.find(item => ts.isPropertyAssignment(item) &&
      (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name)?.initializer : null;
  const literal = node => node && ts.isStringLiteral(node) ? node.text : null;
  const calls = [];
  for (const statement of parsed.statements) {
    const expressions = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map(item => item.initializer)
      : ts.isExpressionStatement(statement) ? [statement.expression] : [];
    for (let expression of expressions) {
      if (expression && ts.isAwaitExpression(expression)) expression = expression.expression;
      if (!expression || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) ||
          !imported.includes(expression.expression.text) || literal(expression.arguments[0]) !== "bohemia_pr") continue;
      const input = expression.arguments[1], options = expression.arguments[2];
      if (literal(property(input, "action")) !== "create" || literal(property(input, "sourceBranch")) !== branch) continue;
      const environment = options && property(options, "env");
      calls.push({ workspace: environment && literal(property(environment, "BOHEMIA_PR_MCP_SEARCH_ROOTS")),
        repository: literal(property(input, "repository")) });
    }
  }
  return calls.length === 1 ? calls[0] : null;
}

function applyRecordedUpdate(source, patch) {
  if (patch.includes("*** Move to:")) return null;
  for (const section of patch.split(/^@@[^\r\n]*\r?\n/m).filter(Boolean)) {
    const lines = section.split(/\r?\n/).filter(line => /^[ +\-]/.test(line));
    const before = lines.filter(line => line[0] !== "+").map(line => line.slice(1)).join("\n") + "\n";
    const after = lines.filter(line => line[0] !== "-").map(line => line.slice(1)).join("\n") + "\n";
    if (before === "\n" || source.split(before).length !== 2) return null;
    source = source.replace(before, after);
  }
  return source;
}

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

export async function verifyInteractiveCreation({ pr, sessionDirectory, requestEventId, resultEventId,
  workspaceRequestEventId, workspaceResultEventId }) {
  const workspace = readFileSync(path.join(sessionDirectory, "workspace.yaml"), "utf8");
  const field = name => workspace.match(new RegExp(`^${name}:\\s*([^\\r\\n]+)$`, "m"))?.[1].trim();
  const sessionId = field("id"), taskId = field("mc_task_id");
  if (!sessionId || path.basename(sessionDirectory) !== sessionId || !taskId) {
    throw new Error("Interactive creator lacks its original session/work-item identity");
  }
  safeId(taskId);
  let request, result, script, workspaceRequest, workspaceResult;
  const pendingPatches = new Map(), scripts = new Map();
  for await (const line of createInterface({ input: createReadStream(path.join(sessionDirectory, "events.jsonl")), crlfDelay: Infinity })) {
    const event = JSON.parse(line);
    if (event.type === "tool.execution_start" && event.data.toolName === "apply_patch" &&
        typeof event.data.arguments === "string") {
      const patch = event.data.arguments;
      const prior = new Map(scripts);
      for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
        scripts.delete(path.resolve(match[1]));
      }
      pendingPatches.set(event.data.toolCallId, { event, prior });
    }
    if (event.type === "tool.execution_complete" && event.data.success === true) {
      const creation = pendingPatches.get(event.data.toolCallId);
      if (creation) {
        const patch = creation.event.data.arguments;
        for (const match of patch.matchAll(/^\*\*\* (Add|Update) File: (.+)\r?\n([\s\S]*?)(?=^\*\*\* (?:Add|Update|Delete) File:|^\*\*\* End Patch)/gm)) {
          const file = path.resolve(match[2]), previous = creation.prior.get(file);
          const source = match[1] === "Add" ? match[3].split(/\r?\n/).filter(line => line.startsWith("+"))
            .map(line => line.slice(1)).join("\n") + "\n" : previous && applyRecordedUpdate(previous.source, match[3]);
          if (source) scripts.set(file, { file, source,
            requestEventId: previous?.requestEventId || creation.event.id,
            resultEventId: previous?.resultEventId || event.id,
            patches: [...(previous?.patches || []), { requestEventId: creation.event.id, resultEventId: event.id,
              sha256: createHash("sha256").update(patch).digest("hex") }] });
        }
      }
    }
    if (event.type === "tool.execution_start" && event.data.toolName === "powershell") {
      const command = event.data.arguments?.command || "";
      for (const [file] of scripts) {
        if (command.toLowerCase().includes(file.toLowerCase()) &&
            !samePath(executedScript(command, sessionDirectory), file) && !/^\s*Get-Content\b/i.test(command)) scripts.delete(file);
      }
    }
    if (event.id === requestEventId) {
      request = event;
      const file = executedScript(event.data.arguments?.command || "", sessionDirectory);
      script = file && scripts.get(file);
    }
    if (event.id === resultEventId) result = event;
    if (event.id === workspaceRequestEventId) workspaceRequest = event;
    if (event.id === workspaceResultEventId) workspaceResult = event;
    if (request && result && (!workspaceRequestEventId || workspaceRequest && workspaceResult)) break;
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
  const scriptInput = script && scriptCreation(script.source, pr.branch, (await import("typescript")).default);
  let workspaceEvidence;
  if (workspaceRequestEventId || workspaceResultEventId) {
    if (workspaceRequest?.type !== "tool.execution_start" || workspaceResult?.type !== "tool.execution_complete" ||
        !/bohemia[_-]prepare$/.test(workspaceRequest.data.toolName || "") || !workspaceResult.data.success ||
        workspaceRequest.data.toolCallId !== workspaceResult.data.toolCallId) {
      throw new Error("Assigned checkout requires a successful canonical preparation in the original session");
    }
    const preparation = JSON.parse(workspaceResult.data.result.content);
    if (!preparation.ready || preparation.branch !== pr.branch ||
        !samePath(workspaceRequest.data.arguments.repoRoot, preparation.repoRoot)) {
      throw new Error("Assigned checkout preparation does not match this PR");
    }
    workspaceEvidence = { workspaceRequestEventId, workspaceResultEventId, workspace: preparation.repoRoot,
      requestSha256: createHash("sha256").update(JSON.stringify(workspaceRequest)).digest("hex"),
      resultSha256: createHash("sha256").update(JSON.stringify(workspaceResult)).digest("hex") };
  }
  const content = result.data.result?.content;
  const urls = typeof content === "string" ? content.match(/https:\/\/[^\s"'\\]+/g) || [] : [];
  const normalize = value => value.toLowerCase().replace("https://office.visualstudio.com/", "https://dev.azure.com/office/").replace(/\/+$/, "");
  if ((!structuredCreate && !recordedScriptCreate && !scriptInput) || !urls.some(url => normalize(url) === normalize(pr.url))
      || /"isError"\s*:\s*true/.test(content || "")) {
    throw new Error("Original call does not prove creation of this exact PR and branch");
  }
  return { taskId, sessionId, sessionDirectory, requestEventId, resultEventId,
    createdAt: request.timestamp, requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    resultSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    ...(scriptInput ? { scriptEvidence: { file: script.file, requestEventId: script.requestEventId,
      resultEventId: script.resultEventId, sha256: createHash("sha256").update(script.source).digest("hex"),
      patches: script.patches },
      creationWorkspace: scriptInput.workspace, repository: scriptInput.repository } : {}),
    ...(workspaceEvidence ? { workspaceEvidence, workspaceRequestEventId, workspaceResultEventId } : {}) };
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
  if (JSON.stringify(evidence.scriptEvidence) !== JSON.stringify(owner.creationEvidence.scriptEvidence) ||
      JSON.stringify(evidence.workspaceEvidence) !== JSON.stringify(owner.creationEvidence.workspaceEvidence) ||
      ((evidence.workspaceEvidence || evidence.creationWorkspace) &&
        !samePath(evidence.workspaceEvidence?.workspace || evidence.creationWorkspace, owner.workspace))) {
    throw new Error("Interactive creator script/checkout provenance changed; import held");
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
