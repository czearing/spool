import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentError, readAgentSource, withAgentLock } from "./agents";
import { agentModel, replaceAgentModel } from "./agent-model";
import { hasCode } from "./file-snapshot";
import { readOptionalJson } from "./spool-publish";
import { validModel } from "./settings";

export type ModelSettings = { model: string | null; defaultModel: string; revision: string;
  description?: string; icon?: string; image?: string | null; maxConcurrentRuns?: number | null };
const digest = (source: string) => createHash("sha256").update(source).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
async function projectSource(root: string) {
  const file = join(root, "spool.json");
  let source: string | undefined;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 131072) throw new AgentError("Invalid Spool settings file.");
    source = await readFile(file, "utf8");
  } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  const data: unknown = source === undefined ? { version: 1, defaultModel: "gpt-5.4" } : JSON.parse(source);
  if (!record(data) || data.version !== 1 || !validModel(data.defaultModel) || !data.defaultModel) {
    throw new AgentError("Invalid Spool project settings.");
  }
  return { file, source: source ?? "", data, defaultModel: data.defaultModel };
}
export async function readModelSettings(root: string, agent?: string): Promise<ModelSettings> {
  const project = await projectSource(root);
  const source = agent ? (await readAgentSource(root, agent)).source : project.source;
  return { model: agent ? agentModel(source) : project.defaultModel, defaultModel: project.defaultModel, revision: digest(source) };
}
async function assertSupported(root: string) {
  const capability = await readOptionalJson(join(root, "controls", "capabilities.json"));
  const age = record(capability) && typeof capability.updatedAt === "string" ? Date.now() - Date.parse(capability.updatedAt) : NaN;
  if (!record(capability) || capability.projectModelVersion !== 1 || !Number.isFinite(age) || age < 0 || age >= 15000) {
    throw new AgentError("Start an updated Spool daemon before changing model settings.", 503);
  }
}
export async function saveModelSettings(root: string, agent: string | undefined, input: unknown): Promise<ModelSettings> {
  if (!record(input) || !(agent && input.model === null || validModel(input.model) && input.model !== "") ||
    typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision)) throw new AgentError("Invalid model settings.");
  const model = input.model as string | null;
  await assertSupported(root);
  const save = async () => {
    const current = agent ? await readAgentSource(root, agent) : await projectSource(root);
    if (digest(current.source) !== input.revision) throw new AgentError("Settings changed. Reload before saving.", 409);
    const source = agent ? replaceAgentModel(current.source, model)
      : JSON.stringify({ ...(await projectSource(root)).data, defaultModel: model }, null, 2) + "\n";
    const temporary = `${current.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, source, { flag: "wx", mode: "mode" in current ? current.mode : 0o600 });
      const latest = agent ? await readAgentSource(root, agent) : await projectSource(root);
      if (digest(latest.source) !== input.revision) throw new AgentError("Settings changed while saving. Reload and retry.", 409);
      await rename(temporary, current.file);
    } finally { await rm(temporary, { force: true }); }
    return { model, defaultModel: agent ? (await projectSource(root)).defaultModel : model!, revision: digest(source) };
  };
  if (agent) return withAgentLock(root, agent, save);
  const lockFile = join(root, "spool.json.lock");
  let lock;
  try { lock = await open(lockFile, "wx", 0o600); }
  catch (error) { if (hasCode(error, "EEXIST")) throw new AgentError("Project settings are being changed. Try again.", 409); throw error; }
  try { return await save(); }
  finally { await lock.close(); await rm(lockFile); }
}
