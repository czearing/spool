import { randomUUID } from "node:crypto";
import { link, lstat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentError, listAgents, readAgentPrompt, readAgentSource, withAgentLock } from "./agents";
import { getProjects } from "./projects";
import { hasCode } from "./file-snapshot";
import { readOptionalJson } from "./spool-publish";
import { resolveSharedPrompt, sharedPromptFile, withPromptFileLock } from "./shared-prompts";

export type ImportAgent = { name: string; sourceProject: string; sourceAgent: string; revision: string; context: string };
export type AgentCatalog = { projects: { id: string; name: string; agents: string[]; error?: string }[] };
export async function agentCatalog(target: string): Promise<AgentCatalog> {
  const projects = await getProjects();
  if (!projects.some(project => project.id === target)) throw new AgentError("Project not found.", 404);
  return { projects: await Promise.all(projects.filter(project => project.id !== target).map(async project => {
    try { return { id: project.id, name: project.name, agents: await listAgents(project.root) }; }
    catch (error) {
      console.error(`Agent library is unavailable for ${project.id}.`, error);
      return { id: project.id, name: project.name, agents: [], error: "This project's agents could not be read." };
    }
  })) };
}
async function ready(root: string) {
  const value = await readOptionalJson(join(root, "controls", "capabilities.json"));
  const capability = value && typeof value === "object" ? value : {};
  const age = "updatedAt" in capability && typeof capability.updatedAt === "string" ? Date.now() - Date.parse(capability.updatedAt) : NaN;
  if (!("sharedPromptsVersion" in capability) || capability.sharedPromptsVersion !== 1 ||
    !Number.isFinite(age) || age < 0 || age >= 15000) {
    throw new AgentError("This project needs a running Spool runtime with shared-prompt support before importing.", 503);
  }
}
export async function importAgent(target: string, input: unknown) {
  if (!input || typeof input !== "object" || !("name" in input) || typeof input.name !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(input.name) || !("sourceProject" in input) || typeof input.sourceProject !== "string" ||
    !("sourceAgent" in input) || typeof input.sourceAgent !== "string" ||
    !("revision" in input) || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision) ||
    !("context" in input) || typeof input.context !== "string" || input.context.includes("\0") ||
    Buffer.byteLength(input.context) > 16000) throw new AgentError("Choose a source agent, a valid name and project instructions under 16 KB.");
  const { name, sourceAgent, context } = input;
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) throw new AgentError("Choose an agent name that is not reserved by the operating system.");
  const projects = await getProjects(), destination = projects.find(project => project.id === target);
  const sourceProject = projects.find(project => project.id === input.sourceProject);
  if (!destination || !sourceProject) throw new AgentError("Project not found.", 404);
  if (target === sourceProject.id) throw new AgentError("Choose an agent from another project.");
  await ready(destination.root);
  const directory = join(destination.root, "agents");
  if (!(await lstat(directory)).isDirectory()) throw new AgentError("Agent storage must be a regular directory.");
  const targetFile = join(directory, `${name}.md`);
  return withPromptFileLock(targetFile, async () => {
    try { await lstat(targetFile); throw new AgentError("An agent with this name already exists. Choose another name.", 409); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    return withAgentLock(sourceProject.root, sourceAgent, async () => {
      const source = await readAgentSource(sourceProject.root, sourceAgent);
      const document = await readAgentPrompt(sourceProject.root, sourceAgent);
      if (!document.prompt.trim() || document.prompt.includes("\0")) throw new AgentError("The source agent needs valid instructions before it can be shared.");
      if (document.revision !== input.revision) throw new AgentError("Source instructions changed. Reload the preview before importing.", 409);
      const reference = sharedPromptFile(source.source);
      const sharedFile = reference ? (await resolveSharedPrompt(reference)).file : source.file;
      const publish = async () => {
        if ((await readAgentPrompt(sourceProject.root, sourceAgent)).revision !== input.revision)
          throw new AgentError("Source instructions changed. Reload the preview before importing.", 409);
        const temporary = `${targetFile}.${randomUUID()}.tmp`;
        try {
          const header = `---\ndescription: ${JSON.stringify(`Imported from ${sourceProject.name}`)}\nicon: "bot"\nmax_concurrent_runs: 1\n`;
          const scope = `This instance belongs to ${destination.name}. Use only this project's assigned workspace and tools. ` +
            "Source-project paths do not authorize work there. Ask for a workspace if neither the task nor these project instructions supplies one.";
          const body = `${scope}\n\n${context.trim()}`;
          if (Buffer.byteLength(body) > 16000) throw new AgentError("Project instructions including their project boundary must be under 16 KB.");
          await writeFile(temporary, `${header}shared_prompt: ${JSON.stringify(sharedFile)}\n---\n${body}\n`, { flag: "wx", mode: 0o600 });
          await link(temporary, targetFile);
          return { name, shared: true };
        } catch (error) {
          if (hasCode(error, "EEXIST")) throw new AgentError("An agent with this name already exists.", 409);
          throw error;
        } finally { await rm(temporary, { force: true }); }
      };
      return reference ? withPromptFileLock(sharedFile, publish) : publish();
    });
  });
}
