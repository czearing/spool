import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentCatalog, copyAgent } from "./agent-copy";
import { deleteAgent, readAgentPrompt, saveAgentPrompt } from "./agents";
import { deleteProject, getProjects } from "./projects";
import { sharedPromptFile } from "./shared-prompts";
import { GET, POST } from "../app/api/projects/[project]/agent-copy/route";

const sandbox = vi.hoisted(() => ({ data: "" }));
vi.mock("./application-paths", () => ({ applicationPaths: () => ({ data: sandbox.data, resources: sandbox.data }) }));
let root: string, source: string, target: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-copy-"));
  source = join(root, "source"); target = join(root, "target");
  sandbox.data = root;
  for (const directory of [source, target]) {
    for (const name of ["agents", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
      await mkdir(join(directory, name), { recursive: true });
  }
  await writeFile(join(source, "agents", "designer.md"),
    '---\ndescription: "Product designer"\nmodel: source-model\nicon: pen-tool\nmax_concurrent_runs: null\nreasoning_effort: high\ntools: read,search\n---\n# Design\nResearch before recommending.\n');
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [
    { id: "source", name: "Source", root: source }, { id: "target", name: "Target", root: target },
  ] }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function draft(name = "designer") {
  return { name, sourceProject: "source", sourceAgent: "designer", revision: (await readAgentPrompt(source, "designer")).revision };
}
async function legacyLink(name = "linked", reference?: string) {
  reference ??= join(await realpath(source), "agents", "designer.md");
  const file = join(target, "agents", `${name}.md`);
  await writeFile(file, `---\nmodel: linked-model\nshared_prompt: ${JSON.stringify(reference)}\n---\nPrivate source-project context`);
  return file;
}
it("copies instructions and settings without creating a shared reference or modifying the source", async () => {
  const before = await readFile(join(source, "agents", "designer.md"), "utf8");
  expect(await copyAgent("target", await draft())).toEqual({ name: "designer", copied: true });
  const a = await readAgentPrompt(source, "designer"), b = await readAgentPrompt(target, "designer");
  expect(b.prompt).toBe(a.prompt);
  expect(a.shared).toBeUndefined();
  expect(b.shared).toBeUndefined();
  expect(b.linked).toBeUndefined();
  expect(await readFile(join(source, "agents", "designer.md"), "utf8")).toBe(before);
  expect(await readFile(join(target, "agents", "designer.md"), "utf8")).toBe(before);
  expect(sharedPromptFile(await readFile(join(target, "agents", "designer.md"), "utf8"))).toBeUndefined();
});
it("keeps source and copied edits independent in both directions", async () => {
  await copyAgent("target", await draft());
  await saveAgentPrompt(target, "designer", { ...await readAgentPrompt(target, "designer"), prompt: "Target-only instructions" });
  expect((await readAgentPrompt(source, "designer")).prompt).toContain("Research before recommending");
  await saveAgentPrompt(source, "designer", { ...await readAgentPrompt(source, "designer"), prompt: "Source-only instructions" });
  expect((await readAgentPrompt(target, "designer")).prompt).toBe("Target-only instructions");
});
it("keeps copied agents working after deleting the source agent and disconnecting its project", async () => {
  await copyAgent("target", await draft());
  await deleteAgent(source, "designer");
  await deleteProject("source");
  expect((await readAgentPrompt(target, "designer")).prompt).toContain("Research before recommending");
  expect((await getProjects()).map(project => project.id)).toEqual(["target"]);
  await deleteAgent(target, "designer");
});
it("does not copy source workspaces, job history, or controls and needs no running daemon", async () => {
  const file = join(source, "agents", "designer.md");
  await writeFile(file, `---\nmodel: source-model\ndefault_workspace: ${JSON.stringify(source)}\n---\n# Role\n`);
  await writeFile(join(source, "queues", "completed", "old.json"), '{"id":"old"}');
  await copyAgent("target", await draft());
  const copied = await readFile(join(target, "agents", "designer.md"), "utf8");
  expect(copied).toContain("model: source-model");
  expect(copied).not.toContain("default_workspace");
  expect(await readdir(join(target, "queues", "completed"))).toEqual([]);
  expect(await readdir(target)).toEqual(["agents", "queues"]);
});
it("allows copying a blank agent and preserves CRLF configuration", async () => {
  await writeFile(join(source, "agents", "designer.md"), "---\r\nmodel: source-model\r\n---\r\n");
  await copyAgent("target", await draft());
  expect((await readAgentPrompt(target, "designer")).prompt).toBe("");
  expect(await readFile(join(target, "agents", "designer.md"), "utf8")).toBe("---\r\nmodel: source-model\r\n---\r\n");
});
it("rejects duplicate names and changed source previews without overwriting existing work", async () => {
  const input = await draft();
  await writeFile(join(target, "agents", "designer.md"), "Existing local role");
  await expect(copyAgent("target", input)).rejects.toMatchObject({ status: 409 });
  expect(await readFile(join(target, "agents", "designer.md"), "utf8")).toBe("Existing local role");
  await writeFile(join(source, "agents", "designer.md"), "Changed source role");
  await expect(copyAgent("target", { ...input, name: "other" })).rejects.toMatchObject({ status: 409 });
  expect(await readdir(join(target, "agents"))).toEqual(["designer.md"]);
});
it("serializes duplicate copies without leaving locks or temporary files", async () => {
  const input = await draft();
  const results = await Promise.allSettled([copyAgent("target", input), copyAgent("target", input)]);
  expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(await readdir(join(target, "agents"))).toEqual(["designer.md"]);
  expect(await readdir(join(source, "agents"))).toEqual(["designer.md"]);
});
it.each(["../outside", "nul", "Uppercase", "a".repeat(65)])("rejects invalid copy names: %s", async name => {
  await expect(copyAgent("target", { ...await draft(), name })).rejects.toMatchObject({ status: 400 });
  expect(await readdir(join(target, "agents"))).toEqual([]);
});
it("keeps the catalog project-scoped and reports unknown projects explicitly", async () => {
  expect(await agentCatalog("target")).toEqual({ projects: [{ id: "source", name: "Source", agents: ["designer"] }] });
  await expect(copyAgent("target", { ...await draft(), sourceProject: "target" })).rejects.toMatchObject({ status: 400 });
  await expect(copyAgent("missing", await draft())).rejects.toMatchObject({ status: 404 });
  await expect(agentCatalog("missing")).rejects.toMatchObject({ status: 404 });
});
it("flattens an existing linked agent into an independent snapshot without its private project context", async () => {
  await legacyLink();
  const preview = await readAgentPrompt(target, "linked");
  await copyAgent("source", { name: "standalone", sourceProject: "target", sourceAgent: "linked", revision: preview.revision });
  const copied = await readFile(join(source, "agents", "standalone.md"), "utf8");
  expect(copied).toContain("model: linked-model");
  expect(copied).toContain("Research before recommending");
  expect(copied).not.toMatch(/shared_prompt|Private source-project context/);
  await deleteAgent(target, "linked");
  await deleteAgent(source, "designer");
  expect((await readAgentPrompt(source, "standalone")).prompt).toBe(preview.prompt);
});
it("leaves existing legacy links readable, editable, and protected from source deletion", async () => {
  await legacyLink();
  const preview = await readAgentPrompt(target, "linked");
  expect(preview.linked).toBe(true);
  await saveAgentPrompt(target, "linked", { ...preview, prompt: "Updated legacy role" });
  expect((await readAgentPrompt(source, "designer")).prompt).toBe("Updated legacy role");
  expect((await readAgentPrompt(target, "linked", "context")).prompt).toBe("Private source-project context");
  await expect(deleteAgent(source, "designer")).rejects.toMatchObject({ status: 409 });
  await expect(deleteProject("source")).rejects.toMatchObject({ status: 409 });
});
it("rejects missing, unregistered, or cyclic legacy instructions without publishing partial copies", async () => {
  await legacyLink("missing", join(await realpath(source), "agents", "missing.md"));
  await expect(copyAgent("source", { name: "copy", sourceProject: "target", sourceAgent: "missing", revision: "a".repeat(64) })).rejects.toThrow("missing");
  const file = await legacyLink("cycle", join(await realpath(target), "agents", "cycle.md"));
  await expect(copyAgent("source", { name: "copy", sourceProject: "target", sourceAgent: "cycle", revision: "a".repeat(64) })).rejects.toThrow("circular");
  await writeFile(file, `---\nshared_prompt: ${JSON.stringify(join(root, "unknown", "designer.md"))}\n---\nLocal only`);
  await expect(copyAgent("source", { name: "copy", sourceProject: "target", sourceAgent: "cycle", revision: "a".repeat(64) })).rejects.toThrow("project is unavailable");
  expect(await readdir(join(source, "agents"))).toEqual(["designer.md"]);
});
it("enforces the editor size limit when flattening a legacy role plus instance settings", async () => {
  await writeFile(join(source, "agents", "designer.md"), "x".repeat(120000));
  const file = await legacyLink();
  const content = await readFile(file, "utf8");
  await writeFile(file, content.replace("model: linked-model", `description: "${"x".repeat(20000)}"`));
  const preview = await readAgentPrompt(target, "linked");
  await expect(copyAgent("source", { name: "copy", sourceProject: "target", sourceAgent: "linked", revision: preview.revision })).rejects.toMatchObject({ status: 413 });
  expect(await readdir(join(source, "agents"))).toEqual(["designer.md"]);
});
it("serves the copy catalog and validates copy requests before creating an agent", async () => {
  const context = { params: Promise.resolve({ project: "target" }) };
  const request = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/projects/target/agent-copy", {
    method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers }, body,
  });
  expect((await GET(new Request("http://localhost/api/projects/target/agent-copy"), context)).status).toBe(200);
  expect((await POST(request("{}", { origin: "https://foreign.invalid" }), context)).status).toBe(403);
  expect((await POST(request("{}", { "content-type": "text/plain" }), context)).status).toBe(415);
  expect((await POST(request("{broken"), context)).status).toBe(400);
  expect((await POST(request("x".repeat(24001)), context)).status).toBe(413);
  expect(await readdir(join(target, "agents"))).toEqual([]);
  const response = await POST(request(JSON.stringify(await draft())), context);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ name: "designer", copied: true });
});
