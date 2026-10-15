import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentCatalog, importAgent } from "./agent-import";
import { deleteAgent, readAgentPrompt, saveAgentPrompt } from "./agents";
import { sharedPromptFile } from "./shared-prompts";

let root: string, source: string, target: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-shared-"));
  source = join(root, "source"); target = join(root, "target");
  vi.stubEnv("SPOOL_PROJECTS_FILE", join(root, "projects.json"));
  for (const directory of [source, target]) {
    for (const name of ["agents", "controls", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
      await mkdir(join(directory, name), { recursive: true });
  }
  await writeFile(join(source, "agents", "designer.md"), '---\nmodel: source-model\nmax_concurrent_runs: null\n---\n# Design\nResearch before recommending.\n');
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [
    { id: "source", name: "Source", root: source }, { id: "target", name: "Target", root: target },
  ] }));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function draft(name = "designer") {
  return { name, sourceProject: "source", sourceAgent: "designer", revision: (await readAgentPrompt(source, "designer")).revision,
    context: "Use repository B; never change repository A." };
}
it("imports one shared definition with independent context and settings", async () => {
  const before = await readFile(join(source, "agents", "designer.md"), "utf8");
  expect(await importAgent("target", await draft())).toEqual({ name: "designer", shared: true });
  const a = await readAgentPrompt(source, "designer"), b = await readAgentPrompt(target, "designer");
  expect(a.prompt).toBe(b.prompt);
  expect(a.revision).toBe(b.revision);
  expect(a.shared).toBe(true);
  await expect(readAgentPrompt(source, "designer", "context")).rejects.toMatchObject({ status: 400 });
  expect((await readAgentPrompt(target, "designer", "context")).prompt).toContain("repository B");
  const original = await readFile(join(source, "agents", "designer.md"), "utf8");
  const imported = await readFile(join(target, "agents", "designer.md"), "utf8");
  expect(original).toContain("model: source-model");
  expect(original).toBe(before);
  expect(imported).not.toContain("source-model");
  expect(imported).toContain("max_concurrent_runs: 1");
  expect(original).toContain("Research before recommending");
  expect(imported).not.toContain("Research before recommending");
  expect(sharedPromptFile(imported)).toBe(join(await realpath(source), "agents", "designer.md"));
});
it("propagates shared edits while retaining each instance's private context", async () => {
  await importAgent("target", await draft());
  const a = await readAgentPrompt(source, "designer");
  await saveAgentPrompt(target, "designer", { ...a, prompt: "Updated shared role" });
  expect((await readAgentPrompt(source, "designer")).prompt).toBe("Updated shared role");
  await expect(saveAgentPrompt(source, "designer", { ...a, prompt: "Stale edit" })).rejects.toMatchObject({ status: 409 });
  const context = await readAgentPrompt(target, "designer", "context");
  await saveAgentPrompt(target, "designer", { ...context, prompt: "Only project B" }, "context");
  expect((await readAgentPrompt(source, "designer")).prompt).not.toContain("Only project B");
  expect((await readAgentPrompt(target, "designer")).prompt).toBe("Updated shared role");
  await expect(saveAgentPrompt(source, "designer", { ...await readAgentPrompt(source, "designer"), prompt: "" }))
    .rejects.toThrow("cannot be empty");
});
it("reuses the same definition and protects its original instance from deletion", async () => {
  await importAgent("target", await draft());
  await importAgent("target", await draft("another-designer"));
  await expect(deleteAgent(source, "designer")).rejects.toMatchObject({ status: 409 });
  expect((await readAgentPrompt(target, "another-designer")).prompt).toContain("Research before recommending");
  await deleteAgent(target, "designer");
  expect((await readAgentPrompt(target, "another-designer")).shared).toBe(true);
  await deleteAgent(target, "another-designer");
  await deleteAgent(source, "designer");
});
it("rejects duplicate names and changed source previews without overwriting work", async () => {
  const input = await draft();
  await writeFile(join(target, "agents", "designer.md"), "Existing local role");
  await expect(importAgent("target", input)).rejects.toMatchObject({ status: 409 });
  expect(await readFile(join(target, "agents", "designer.md"), "utf8")).toBe("Existing local role");
  await writeFile(join(source, "agents", "designer.md"), "Changed source role");
  await expect(importAgent("target", { ...input, name: "other" })).rejects.toMatchObject({ status: 409 });
  expect(await readdir(join(target, "agents"))).toEqual(["designer.md"]);
});
it.each([
  {},
  { sharedPromptsVersion: 0, updatedAt: new Date().toISOString() },
  { sharedPromptsVersion: 1, updatedAt: "invalid" },
  { sharedPromptsVersion: 1, updatedAt: new Date(Date.now() + 60000).toISOString() },
])("rejects incompatible or invalid active runtime capabilities without mutating the source: %j", async capability => {
  const before = await readFile(join(source, "agents", "designer.md"), "utf8");
  await writeFile(join(target, "controls", "capabilities.json"), JSON.stringify(capability));
  await expect(importAgent("target", await draft())).rejects.toMatchObject({ status: 503 });
  expect(await readFile(join(source, "agents", "designer.md"), "utf8")).toBe(before);
  expect(await readdir(join(target, "agents"))).toEqual([]);
});
it.each([0, 1])("imports offline when the last runtime heartbeat is stale (shared prompts version %i)", async version => {
  await writeFile(join(target, "controls", "capabilities.json"),
    JSON.stringify({ sharedPromptsVersion: version, updatedAt: new Date(Date.now() - 60000).toISOString() }));
  await importAgent("target", await draft());
  expect((await readAgentPrompt(target, "designer")).prompt).toContain("Research before recommending");
});
it("imports while a compatible runtime is active", async () => {
  await writeFile(join(target, "controls", "capabilities.json"),
    JSON.stringify({ sharedPromptsVersion: 1, updatedAt: new Date().toISOString() }));
  await importAgent("target", await draft());
  expect((await readAgentPrompt(target, "designer")).shared).toBe(true);
});
it("serializes duplicate imports without leaving lock or temporary files", async () => {
  const input = await draft();
  const results = await Promise.allSettled([importAgent("target", input), importAgent("target", input)]);
  expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(await readdir(join(target, "agents"))).toEqual(["designer.md"]);
  expect(await readdir(join(source, "agents"))).toEqual(["designer.md"]);
});
it("fails explicitly on missing shared instructions instead of executing only local context", async () => {
  await importAgent("target", await draft());
  const file = sharedPromptFile(await readFile(join(target, "agents", "designer.md"), "utf8"));
  if (!file) throw new Error("Expected a shared prompt reference");
  await rm(file);
  await expect(readAgentPrompt(target, "designer")).rejects.toThrow();
});
it("keeps the catalog project-scoped and rejects unsafe references and import names", async () => {
  expect(await agentCatalog("target")).toEqual({ projects: [{ id: "source", name: "Source", agents: ["designer"] }] });
  await expect(importAgent("target", { ...await draft(), name: "../outside" })).rejects.toMatchObject({ status: 400 });
  await expect(importAgent("target", { ...await draft(), name: "nul" })).rejects.toMatchObject({ status: 400 });
  await expect(importAgent("target", { ...await draft(), sourceProject: "target" })).rejects.toMatchObject({ status: 400 });
  expect(() => sharedPromptFile('---\nshared_prompt: "C:\\\\outside.json"\n---')).toThrow("registered project");
});
it("imports from an older source runtime and flattens links without copying another instance's context", async () => {
  await writeFile(join(source, "controls", "capabilities.json"), "{}");
  await importAgent("target", await draft());
  await writeFile(join(source, "controls", "capabilities.json"),
    JSON.stringify({ sharedPromptsVersion: 1, updatedAt: new Date().toISOString() }));
  await importAgent("source", { name: "linked", sourceProject: "target", sourceAgent: "designer",
    revision: (await readAgentPrompt(target, "designer")).revision, context: "Only source instance" });
  const imported = await readFile(join(source, "agents", "linked.md"), "utf8");
  expect(sharedPromptFile(imported)).toBe(join(await realpath(source), "agents", "designer.md"));
  expect(imported).not.toContain("repository B");
  expect(imported).toContain("Only source instance");
});
it("rejects cycles and unregistered shared references", async () => {
  await importAgent("target", await draft());
  await writeFile(join(source, "agents", "designer.md"),
    `---\nshared_prompt: ${JSON.stringify(join(await realpath(target), "agents", "designer.md"))}\n---\nLocal only`);
  await expect(readAgentPrompt(target, "designer")).rejects.toThrow("circular");
  await writeFile(join(target, "agents", "designer.md"),
    `---\nshared_prompt: ${JSON.stringify(join(root, "unknown", "designer.md"))}\n---\nLocal only`);
  await expect(readAgentPrompt(target, "designer")).rejects.toThrow("project is unavailable");
});
