import { randomUUID } from "node:crypto";
import { existsSync, linkSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import { writeRunnerJson } from "../packages/bohemia-agent-tooling/src/runner-files.js";
import { readJson, safeId } from "./task-records.mjs";

export { readJson, safeId };
export { digest } from "./control-identity.mjs";
export const canonicalPath = value => (existsSync(value) ? realpathSync.native(value) : path.resolve(value)).toLowerCase();
export const samePath = (a, b) => !!a && !!b && canonicalPath(a) === canonicalPath(b);
export const verifiedWorkspaceMigration = (metadata, previousWorkspace, workspace) =>
  (metadata?.workspaceMigration?.reason === "isolated_pr_workspace" ||
    (metadata?.workspaceMigration?.reason === "assigned_agent_workspace" &&
      samePath(metadata.workspaceMigration.assignedWorkspace, workspace))) &&
  (samePath(metadata.workspaceMigration.previousWorkspace, previousWorkspace) ||
    (metadata.workspaceMigration.reason === "assigned_agent_workspace" &&
      samePath(metadata.workspaceMigration.originalWorkspace, previousWorkspace))) &&
  metadata.preparation?.ready && !!metadata.preparation.branch && !!metadata.preparation.commit &&
  samePath(metadata.preparation.repoRoot, workspace);
export const writeJson = writeRunnerJson;

export function operatorConversation(root, task) {
  const id = task?.id?.match(/^manual-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i)?.[1];
  if (!id || task.acceptance || task.runner_metadata?.preparation || task.runner_metadata?.runner &&
      task.runner_metadata.runner !== "manual-dashboard" ||
      !task.interaction?.applied_requests?.includes(id)) return false;
  const receipt = readJson(path.join(root, "controls", "ui-submissions", `${id}.json`));
  if (receipt?.taskId === task.id && ["reserved", "published"].includes(receipt.phase) &&
      /^[a-f0-9]{64}$/.test(receipt.fingerprint || "")) return true;
  const command = readJson(path.join(root, "controls", "commands", `${id}.json`));
  return task.runner_metadata?.runner === "manual-dashboard" &&
    command?.input?.kind === "create" && command.request?.taskId === task.id &&
    command.request.agent === task.agent;
}

export function queuedOperatorMessage(root, task) {
  return !!(path.isAbsolute(root || "") && task?.session_id && task.interaction?.messages?.some(message => {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(message.id || "") ||
        message.status !== "queued" || !task.interaction.applied_requests?.includes(message.id)) return false;
    const command = readJson(path.join(root, "controls", "commands", `${message.id}.json`));
    return command?.input?.kind === "message" && command.input.metadata === undefined &&
      command.input.id === message.id && command.input.taskId === task.id && command.input.message === message.text &&
      command.conversation?.sessionId === task.session_id && command.request?.kind === "message" &&
      command.request.taskId === task.id && command.request.agent === task.agent &&
      samePath(command.request.workspace, task.workspace ?? root);
  }));
}

export function publishOnce(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeJson(temp, value);
  try { linkSync(temp, file); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { unlinkSync(temp); }
  return readJson(file);
}
