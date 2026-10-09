import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasCode, readFileSnapshot } from "./file-snapshot";
import { agentHeader } from "./agent-frontmatter";

export type AgentPrompt = { id: string; prompt: string; revision: string };
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
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(/* turbopackIgnore: true */ file)); }
  catch (error) { if (error instanceof TypeError) throw new AgentError("Agent prompts must contain valid UTF-8 text."); throw error; }
  return { file, source, mode: stats.mode };
}
export async function readAgentPrompt(root: string, id: string): Promise<AgentPrompt> {
  try {
    const { source } = await readAgentSource(root, id);
    return { id, prompt: splitPrompt(source).prompt, revision: revision(source) };
  } catch (error) { if (hasCode(error, "ENOENT")) throw new AgentError("Agent not found.", 404); throw error; }
}
export async function saveAgentPrompt(root: string, id: string, input: unknown): Promise<AgentPrompt> {
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
    if (revision(current.source) !== input.revision) {
      throw new AgentError("This prompt changed on disk. Your edits are kept here; reload to review the latest version before saving.", 409);
    }
    const { prefix, suffix } = splitPrompt(current.source);
    const newline = current.source.includes("\r\n") ? "\r\n" : "\n";
    const prompt = input.prompt.trimEnd().replace(/\r?\n/g, newline);
    const source = prefix + prompt + suffix;
    if (Buffer.byteLength(source) > 131_072) throw new AgentError("The prompt and configuration exceed 128 KiB.", 413);
    await writeFile(temporary, source, { flag: "wx", mode });
    if (revision((await readAgentSource(root, id)).source) !== input.revision) {
      throw new AgentError("This prompt changed while saving. Your edits have not overwritten it.", 409);
    }
    await rename(temporary, file);
    return { id, prompt, revision: revision(source) };
  } finally { await lock.close(); await rm(temporary, { force: true }); await rm(lockFile); }
}
async function assertNoPendingWork(root: string, agent: string) {
  const assignments = await readFileSnapshot(async () => (await Promise.all(["incoming", "in_progress", "requests", "manual", "commands"].map(async (queue) => {
    const control = ["requests", "manual", "commands"].includes(queue);
    const directory = control ? join(root, "controls", queue) : join(root, "queues", queue);
    try {
      return (await readdir(directory, { withFileTypes: true })).filter((file) => file.isFile() && file.name.endsWith(".json"))
        .map((file) => ({ file: join(directory, file.name), name: file.name, request: control, wrapped: queue === "manual" || queue === "commands" }));
    } catch (error) { if (control && hasCode(error, "ENOENT")) return []; throw error; }
  }))).flat().sort((a, b) => a.file.localeCompare(b.file)), async ({ file, name, request, wrapped }) => {
    let task: unknown = JSON.parse(await readFile(file, "utf8"));
    if (wrapped) {
      try {
        const result = JSON.parse(await readFile(join(root, "controls", "results", name), "utf8"));
        if (["accepted", "failed"].includes(result?.result?.status)) return undefined;
      } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      task = task && typeof task === "object" && "request" in task ? task.request : undefined;
    }
    if (request && task && typeof task === "object" && "kind" in task && task.kind !== "create" && task.kind !== "handoff") return undefined;
    if (!task || typeof task !== "object" || !("agent" in task) || typeof task.agent !== "string") {
      throw new Error("Cannot verify pending work: invalid task assignment.");
    }
    return task.agent;
  }, "Pending agent work");
  if (assignments.includes(agent)) throw new AgentError("This agent has queued or in-progress work. Finish or reassign that work before deleting it.", 409);
}
export async function deleteAgent(root: string, id: string) {
  const { file } = await agentFile(root, id), lock = await lockAgent(file);
  try {
    await assertNoPendingWork(root, id);
    await agentFile(root, id);
    await rm(file);
  } finally { await lock.close(); await rm(`${file}.lock`); }
}
