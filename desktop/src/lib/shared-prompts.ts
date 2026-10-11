import { createHash } from "node:crypto";
import { open, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, normalize } from "node:path";
import { AgentError, listAgents, readAgentSource, saveAgentPrompt } from "./agents";
import { agentHeader } from "./agent-frontmatter";
import { getProjects } from "./projects";
import { hasCode } from "./file-snapshot";

export const promptRevision = (source: string) => createHash("sha256").update(source).digest("hex");
const key = (path: string) => process.platform === "win32" ? normalize(path).toLowerCase() : normalize(path);
export function sharedPromptFile(source: string) {
  const fields = agentHeader(source).text.split(/\r?\n/).filter(line => /^\s*shared_prompt\s*:/.test(line));
  if (!fields.length) return undefined;
  if (fields.length !== 1) throw new AgentError("Duplicate shared prompt reference.", 503);
  let file: unknown;
  try { file = JSON.parse(fields[0].slice(fields[0].indexOf(":") + 1).trim()); }
  catch { throw new AgentError("The shared prompt reference is invalid.", 503); }
  if (typeof file !== "string" || !isAbsolute(file) || !/^[a-zA-Z0-9_-]{1,120}\.md$/.test(basename(file)))
    throw new AgentError("The shared prompt must reference an agent in a registered project.", 503);
  return file;
}
export async function sharedPromptOwner(file: string) {
  const id = basename(file, ".md");
  for (const project of await getProjects()) {
    let root = project.root;
    try { root = await realpath(root); }
    catch (error) { if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTDIR")) throw error; }
    if (key(join(root, "agents", `${id}.md`)) === key(file)) return { ...project, agent: id };
  }
  throw new AgentError("The source agent's project is unavailable. Reconnect it before continuing.", 503);
}
export async function resolveSharedPrompt(file: string, seen = new Set<string>()): Promise<{ file: string; prompt: string; revision: string }> {
  if (seen.has(key(file)) || seen.size >= 8) throw new AgentError("Shared instructions contain a circular or excessively nested reference.", 503);
  seen.add(key(file));
  const owner = await sharedPromptOwner(file), { source } = await readAgentSource(owner.root, owner.agent).catch((error: unknown) => {
    if (error instanceof AgentError && error.status === 404) throw new AgentError("Shared source instructions are missing. Restore the source agent before continuing.", 503);
    throw error;
  });
  const next = sharedPromptFile(source);
  if (next) return resolveSharedPrompt(next, seen);
  const { boundary } = agentHeader(source);
  const prompt = (boundary ? source.slice(boundary).trimStart() : source).trimEnd();
  if (!prompt.trim() || prompt.includes("\0")) throw new AgentError("The source agent has empty or invalid instructions.", 503);
  return { file, prompt, revision: promptRevision(source) };
}
export async function readSharedPrompt(file: string) {
  const { prompt, revision } = await resolveSharedPrompt(file);
  return { prompt, revision };
}
export async function sharedPromptUsers(file: string) {
  const users: { project: string; agent: string }[] = [];
  for (const project of await getProjects()) {
    for (const agent of await listAgents(project.root)) {
      if (key(join(await realpath(project.root), "agents", `${agent}.md`)) === key(file)) continue;
      const source = await readAgentSource(project.root, agent), reference = sharedPromptFile(source.source);
      if (reference && key(reference) === key(file)) users.push({ project: project.name, agent });
    }
  }
  return users;
}
export async function withPromptFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  let lock;
  try { lock = await open(`${file}.lock`, "wx", 0o600); }
  catch (error) {
    if (hasCode(error, "EEXIST")) throw new AgentError("These instructions are being updated. Try again.", 409);
    throw error;
  }
  try { return await action(); }
  finally { await lock.close(); await rm(`${file}.lock`); }
}
export async function saveSharedPrompt(file: string, input: { prompt: string; revision: string }) {
  const resolved = await resolveSharedPrompt(file), owner = await sharedPromptOwner(resolved.file);
  if (!input.prompt.trim()) throw new AgentError("Shared instructions cannot be empty.");
  return saveAgentPrompt(owner.root, owner.agent, input);
}
