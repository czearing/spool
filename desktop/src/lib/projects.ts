import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { hasCode } from "./file-snapshot";
import { readSpoolItems } from "./spool";
import { readSpoolArchive } from "./spool-archive";

export type Project = { id: string; name: string; root: string };
export class ProjectError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const registryFile = () => process.env.SPOOL_PROJECTS_FILE ?? join(process.cwd(), ".spool-ui", "projects.json");
const rootKey = (root: string) => process.platform === "win32" ? normalize(root).toLowerCase() : normalize(root);
async function storedRootKey(root: string) {
  try { return rootKey(await realpath(root)); }
  catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return rootKey(root);
    throw error;
  }
}
function isProject(value: unknown): value is Project {
  return !!value && typeof value === "object"
    && "id" in value && typeof value.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id)
    && "name" in value && typeof value.name === "string" && !!value.name.trim() && value.name.length <= 80
    && "root" in value && typeof value.root === "string" && isAbsolute(value.root);
}
export async function getProjects(): Promise<Project[]> {
  let content: string;
  try { content = await readFile(/* turbopackIgnore: true */ registryFile(), "utf8"); }
  catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
  const data: unknown = JSON.parse(content);
  if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1
    || !("projects" in data) || !Array.isArray(data.projects) || !data.projects.every(isProject)) {
    throw new Error("Invalid project registry. Expected version 1 with valid project records.");
  }
  const projects = data.projects;
  for (const key of [(item: Project) => item.id, (item: Project) => item.name.trim().toLowerCase(), (item: Project) => rootKey(item.root)]) {
    if (new Set(projects.map(key)).size !== projects.length) throw new Error("Duplicate project records in the project registry.");
  }
  return projects.map(({ id, name, root }) => ({ id, name, root }));
}
async function validateProject(input: unknown): Promise<Project> {
  if (!input || typeof input !== "object" || !("name" in input) || typeof input.name !== "string"
    || !input.name.trim() || input.name.trim().length > 80) throw new ProjectError("Enter a project name of 1 to 80 characters.");
  if (!("root" in input) || typeof input.root !== "string" || input.root.length > 4096 || !isAbsolute(input.root.trim())) {
    throw new ProjectError("Enter the absolute path to a local Spool folder.");
  }
  let root: string;
  try {
    root = await realpath(input.root.trim());
    await Promise.all([readSpoolItems(root), readSpoolArchive(root)]);
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) throw new ProjectError("This Spool folder must contain queues/incoming, in_progress, completed, and failed.");
    if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) throw new ProjectError("The server cannot read this Spool folder.");
    if (error instanceof Error) throw new ProjectError(`Cannot load this Spool folder: ${error.message}`);
    throw error;
  }
  return { id: randomUUID(), name: input.name.trim(), root };
}
async function saveProject(project: Project): Promise<Project> {
  const file = registryFile(), lockFile = `${file}.lock`, temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  let lock;
  try { lock = await open(lockFile, "wx", 0o600); }
  catch (error) {
    if (hasCode(error, "EEXIST")) throw new ProjectError("Project settings are being updated by another process. Try again.", 409);
    throw error;
  }
  try {
    const projects = await getProjects();
    if (projects.some((item) => item.name.toLowerCase() === project.name.toLowerCase())) throw new ProjectError("A project with this name already exists.", 409);
    // Stored paths may use Windows short names or junctions; compare physical folders.
    const roots = await Promise.all(projects.map((item) => storedRootKey(item.root)));
    if (roots.includes(rootKey(project.root))) throw new ProjectError("This Spool folder is already connected to a project.", 409);
    await writeFile(temporary, JSON.stringify({ version: 1, projects: [...projects, project] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
    return project;
  } finally {
    await lock.close(); await rm(temporary, { force: true }); await rm(lockFile);
  }
}
let pendingWrite = Promise.resolve();
export async function createProject(input: unknown) {
  const project = await validateProject(input);
  const write = pendingWrite.then(() => saveProject(project));
  // Release the write queue after failure; the returned promise still reports the error.
  pendingWrite = write.then(() => undefined, () => undefined);
  return write;
}
