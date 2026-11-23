import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasCode } from "./file-snapshot";
import { agentHeader } from "./agent-frontmatter";
import { readSharedPrompt, saveSharedPrompt, sharedPromptFile, sharedPromptUsers } from "./shared-prompts";

export type AgentPrompt = { id: string; prompt: string; revision: string; shared?: boolean; linked?: boolean; scope?: "turn" };
type PromptScope = "prompt" | "context" | "turn";
export class AgentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,120}$/.test(id);
const revision = (source: string) => createHash("sha256").update(source).digest("hex");
async function agentDirectory(root: string) {
  const directory = join(await realpath(root), "agents");
  if ((await lstat(directory)).isSymbolicLink()) throw new AgentError("Agent folders must not be symbolic links.");
  return directory;
}
export async function listAgents(root: string): Promise<string[]> {
  try {
    const entries = await readdir(await agentDirectory(root), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3)).map((id) => {
        if (!validId(id)) throw new AgentError(`Invalid agent filename: ${id}.md`);
        return id;
      }).sort();
  } catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
}
function splitPrompt(source: string) {
  const { boundary } = agentHeader(source);
  const prefixLength = boundary ? boundary + (source.slice(boundary).match(/^\s*/)?.[0].length ?? 0) : 0;
  const body = source.slice(prefixLength), prompt = body.trimEnd();
  return { prefix: source.slice(0, prefixLength), prompt, suffix: body.slice(prompt.length) };
}
function turnPrompt(source: string) {
  const fields = agentHeader(source).text.split(/\r?\n/).filter(line => /^\s*per_turn_prompt\s*:/.test(line));
  if (fields.length > 1) throw new AgentError("Agent configuration has duplicate per-turn prompts.");
  const value = fields[0]?.slice(fields[0].indexOf(":") + 1).trim() ?? "";
  let prompt: unknown;
  try { prompt = value.startsWith('"') ? JSON.parse(value) : value.replace(/^'|'$/g, ""); }
  catch { throw new AgentError("Invalid per-turn prompt."); }
  if (typeof prompt !== "string" || prompt.includes("\0") || Buffer.byteLength(prompt) > 120_000)
    throw new AgentError("Invalid per-turn prompt.");
  return prompt;
}
function replaceTurnPrompt(source: string, prompt: string) {
  turnPrompt(source);
  const { start, end, text } = agentHeader(source), newline = source.includes("\r\n") ? "\r\n" : "\n";
  const field = prompt ? `per_turn_prompt: ${JSON.stringify(prompt)}${newline}` : "";
  if (end < 0) return field ? `---${newline}${field}---${newline}${source}` : source;
  const clean = text.replace(/^[ \t]*per_turn_prompt[ \t]*:[^\r\n]*(?:\r?\n|$)/gm, "");
  return source.slice(0, start + 3) + clean + (clean.endsWith("\n") ? "" : newline) + field + source.slice(end);
}
async function agentFile(root: string, id: string) {
  if (!validId(id)) throw new AgentError("Invalid agent.", 404);
  try {
    const file = join(await agentDirectory(root), `${id}.md`), stats = await lstat(file);
    if (!stats.isFile()) throw new AgentError("Agent prompts must be regular files.");
    return { file, stats };
  } catch (error) { if (hasCode(error, "ENOENT")) throw new AgentError("Agent not found.", 404); throw error; }
}
async function lockAgent(file: string) {
  try { return await open(`${file}.lock`, "wx", 0o600); }
  catch (error) {
    if (hasCode(error, "EEXIST")) throw new AgentError("This agent is being changed. Try again.", 409);
    throw error;
  }
}
export async function withAgentLock<T>(root: string, id: string, action: () => Promise<T>): Promise<T> {
  const { file } = await agentFile(root, id), lock = await lockAgent(file);
  try { await agentFile(root, id); return await action(); }
  finally { await lock.close(); await rm(`${file}.lock`); }
}
export async function readAgentSource(root: string, id: string) {
  const { file, stats } = await agentFile(root, id);
  if (stats.size > 131_072) throw new AgentError("This agent prompt exceeds the 128 KiB editor limit.", 413);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(file)); }
  catch (error) { if (error instanceof TypeError) throw new AgentError("Agent prompts must contain valid UTF-8 text."); throw error; }
  return { file, source, mode: stats.mode };
}
export async function readAgentPrompt(root: string, id: string, scope: PromptScope = "prompt"): Promise<AgentPrompt> {
  try {
    const { source, file } = await readAgentSource(root, id);
    if (scope === "turn") return { id, prompt: turnPrompt(source), revision: revision(source), scope };
    const shared = sharedPromptFile(source);
    if (scope === "context" && !shared) throw new AgentError("This agent does not use shared instructions.");
    if (shared && scope === "prompt") return { id, ...await readSharedPrompt(shared), shared: true, linked: true };
    return { id, prompt: splitPrompt(source).prompt, revision: revision(source),
      ...(shared ? { shared: true, linked: true } : (await sharedPromptUsers(file)).length ? { shared: true } : {}) };
  } catch (error) { if (hasCode(error, "ENOENT")) throw new AgentError("Agent not found.", 404); throw error; }
}
export async function saveAgentPrompt(root: string, id: string, input: unknown, scope: PromptScope = "prompt"): Promise<AgentPrompt> {
  if (!input || typeof input !== "object" || !("prompt" in input) || typeof input.prompt !== "string" ||
    input.prompt.includes("\0") || Buffer.byteLength(input.prompt) > 120_000 ||
    !("revision" in input) || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision)) {
    throw new AgentError("Provide a prompt (up to 120 KB) and its current revision.");
  }
  let current;
  try { current = await readAgentSource(root, id); }
  catch (error) { if (hasCode(error, "ENOENT")) throw new AgentError("Agent not found.", 404); throw error; }
  const { file, mode } = current, lockFile = `${file}.lock`, temporary = `${file}.${randomUUID()}.tmp`;
  const lock = await lockAgent(file);
  try {
    current = await readAgentSource(root, id);
    const shared = sharedPromptFile(current.source);
    if (scope === "context" && !shared) throw new AgentError("This agent does not use shared instructions.");
    if (scope === "context" && Buffer.byteLength(input.prompt) > 16000) throw new AgentError("Project instructions must be under 16 KB.", 413);
    if (shared && scope === "prompt") {
      const saved = await saveSharedPrompt(shared, { prompt: input.prompt, revision: input.revision });
      return { id, prompt: saved.prompt, revision: saved.revision, shared: true, linked: true };
    }
    if (revision(current.source) !== input.revision) {
      throw new AgentError("This prompt changed on disk. Your edits are kept here; reload to review the latest version before saving.", 409);
    }
    const sharing = scope !== "turn" && !shared && (await sharedPromptUsers(file)).length > 0;
    if (sharing && !input.prompt.trim()) throw new AgentError("Shared instructions cannot be empty.");
    const { prefix, suffix } = splitPrompt(current.source);
    const newline = current.source.includes("\r\n") ? "\r\n" : "\n";
    const prompt = input.prompt.trimEnd().replace(/\r?\n/g, newline);
    const source = scope === "turn" ? replaceTurnPrompt(current.source, prompt) : prefix + prompt + suffix;
    if (Buffer.byteLength(source) > 131_072) throw new AgentError("The prompt and configuration exceed 128 KiB.", 413);
    await writeFile(temporary, source, { flag: "wx", mode });
    if (revision((await readAgentSource(root, id)).source) !== input.revision) {
      throw new AgentError("This prompt changed while saving. Your edits have not overwritten it.", 409);
    }
    await rename(temporary, file);
    return { id, prompt, revision: revision(source), ...(scope === "turn" ? { scope } :
      shared ? { shared: true, linked: true } : sharing ? { shared: true } : {}) };
  } finally { await lock.close(); await rm(temporary, { force: true }); await rm(lockFile); }
}
export async function deleteAgent(root: string, id: string) {
  const { file } = await agentFile(root, id), lock = await lockAgent(file);
  try {
    const users = await sharedPromptUsers(file);
    if (users.length) throw new AgentError(`This prompt is shared with ${users.map(user => `${user.project} / ${user.agent}`).join(", ")}. Remove those linked agents before deleting the source.`, 409);
    await agentFile(root, id);
    await rm(file);
  } finally { await lock.close(); await rm(`${file}.lock`); }
}
