import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { hasCode } from "./file-snapshot";
import { ProjectError } from "./project-error";
import { publishJson } from "./spool-publish";

export type ProjectStorage = { path: string; defaultPath: string; revision: string };
export const projectRegistryFile = () => process.env.SPOOL_PROJECTS_FILE ?? join(process.cwd(), ".spool-ui", "projects.json");
const settingsFile = () => join(dirname(projectRegistryFile()), "project-storage.json");
export async function readProjectStorage(): Promise<ProjectStorage> {
  const defaultPath = join(dirname(projectRegistryFile()), "projects");
  let source = "";
  try { source = await readFile(settingsFile(), "utf8"); }
  catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  const value: unknown = source ? JSON.parse(source) : { version: 1, path: defaultPath };
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
    !("path" in value) || typeof value.path !== "string" || !isAbsolute(value.path)) {
    throw new ProjectError("Project storage settings are invalid. Restore the settings file before continuing.", 503);
  }
  return { path: value.path, defaultPath, revision: createHash("sha256").update(source).digest("hex") };
}
export async function saveProjectStorage(input: unknown): Promise<ProjectStorage> {
  if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string" ||
    !isAbsolute(input.path.trim()) || input.path.length > 4096 || input.path.includes("\0") ||
    !("revision" in input) || typeof input.revision !== "string") throw new ProjectError("Choose an absolute storage folder.");
  const file = settingsFile();
  await mkdir(dirname(file), { recursive: true });
  let lock;
  try { lock = await open(`${file}.lock`, "wx", 0o600); }
  catch (error) { if (hasCode(error, "EEXIST")) throw new ProjectError("Storage settings are being updated. Try again.", 409); throw error; }
  try {
    if ((await readProjectStorage()).revision !== input.revision) throw new ProjectError("Storage settings changed. Reload before saving.", 409);
    await mkdir(input.path.trim(), { recursive: true });
    const path = await realpath(input.path.trim());
    if (!(await stat(path)).isDirectory()) throw new ProjectError("Choose a folder for project data.");
    await publishJson(file, { version: 1, path }, true);
    return readProjectStorage();
  } finally { await lock.close(); await rm(`${file}.lock`); }
}
