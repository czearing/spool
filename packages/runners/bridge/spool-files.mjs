import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import { writeRunnerJson } from "../packages/bohemia-agent-tooling/src/index.js";

export const safeId = value => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) throw new Error("Invalid Spool task id");
  return value;
};
export const digest = value => createHash("sha256").update(value).digest("hex");
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
export function readJson(file) {
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      if (!(error instanceof SyntaxError) || attempt === 12) throw new Error(`Cannot read ${file}: ${error.message}`);
      // The current Spool daemon rewrites task JSON in place. Never accept a partial read.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
export const writeJson = writeRunnerJson;

export function publishOnce(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeJson(temp, value);
  try { linkSync(temp, file); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { unlinkSync(temp); }
  return readJson(file);
}
