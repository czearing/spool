import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, getProjects } from "./projects";
import { spoolQueues } from "./spool";

let root: string, source: string, registry: string;
async function queueRoot(name: string) {
  const directory = join(root, name);
  await Promise.all(spoolQueues.map(({ id }) => mkdir(join(directory, "queues", id), { recursive: true })));
  return directory;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-projects-"));
  registry = join(root, "settings", "projects.json");
  vi.stubEnv("SPOOL_PROJECTS_FILE", registry);
  source = await queueRoot("source");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true }); });

it("starts without hardcoded projects and persists creation across module reloads", async () => {
  expect(await getProjects()).toEqual([]);
  const project = await createProject({ name: " Example ", root: source });
  expect(project.name).toBe("Example");
  expect(await getProjects()).toEqual([project]);
  expect(JSON.parse(await readFile(registry, "utf8"))).toEqual({ version: 1, projects: [project] });
  vi.resetModules();
  expect(await (await import("./projects")).getProjects()).toEqual([project]);
  expect(await readdir(join(root, "settings"))).toEqual(["projects.json"]);
});
it("rejects duplicate names and canonical folders without overwriting the registry", async () => {
  const project = await createProject({ name: "Example", root: source });
  await expect(createProject({ name: "example", root: await queueRoot("other") })).rejects.toMatchObject({ status: 409 });
  await expect(createProject({ name: "Different", root: join(source, ".") })).rejects.toThrow("already connected");
  expect(await getProjects()).toEqual([project]);
});
it("recognizes a stored filesystem alias as the same project folder", async () => {
  const alias = join(root, "alias");
  await symlink(source, alias, "junction"); await mkdir(join(root, "settings"));
  await writeFile(registry, JSON.stringify({ version: 1, projects: [{ id: "existing", name: "Existing", root: alias }] }));
  await expect(createProject({ name: "Duplicate", root: source })).rejects.toThrow("already connected");
  expect(await getProjects()).toHaveLength(1);
});
it("keeps unavailable existing projects without blocking a different new folder", async () => {
  const original = await createProject({ name: "Original", root: source });
  await rm(source, { recursive: true });
  const other = await createProject({ name: "Other", root: await queueRoot("other") });
  expect(await getProjects()).toEqual([original, other]);
});
it.each([
  { name: " ", root: "relative" }, { name: "a".repeat(81), root: "relative" },
  { name: "Example", root: "relative" }, { name: "Example", root: null }, null,
])("rejects invalid project details: %j", async (input) => {
  await expect(createProject(input)).rejects.toMatchObject({ status: 400 });
  expect(await getProjects()).toEqual([]);
});
it("validates actual queue data before persisting a connection", async () => {
  await expect(createProject({ name: "Missing", root: join(root, "missing") })).rejects.toThrow("must contain queues");
  await writeFile(join(source, "queues", "incoming", "BROKEN.json"), "{bad");
  await expect(createProject({ name: "Invalid", root: source })).rejects.toThrow("Cannot load");
  expect(await getProjects()).toEqual([]);
});
it("never overwrites a corrupt registry", async () => {
  await mkdir(join(root, "settings")); await writeFile(registry, "{broken");
  await expect(getProjects()).rejects.toThrow();
  await expect(createProject({ name: "Example", root: source })).rejects.toThrow();
  expect(await readFile(registry, "utf8")).toBe("{broken");
  expect(await readdir(join(root, "settings"))).toEqual(["projects.json"]);
});
it("rejects invalid registry versions and duplicate records", async () => {
  const project = await createProject({ name: "Example", root: source });
  await writeFile(registry, JSON.stringify({ version: 2, projects: [project] }));
  await expect(getProjects()).rejects.toThrow("Invalid project registry");
  await writeFile(registry, JSON.stringify({ version: 1, projects: [project, project] }));
  await expect(getProjects()).rejects.toThrow("Duplicate project records");
});
it("serializes concurrent creates without losing either project", async () => {
  const other = await queueRoot("other");
  const projects = await Promise.all([createProject({ name: "One", root: source }), createProject({ name: "Two", root: other })]);
  expect(await getProjects()).toEqual(expect.arrayContaining(projects));
  expect(await getProjects()).toHaveLength(2);
});
it("rejects concurrent duplicate creates and respects another process's lock", async () => {
  const results = await Promise.allSettled([createProject({ name: "One", root: source }), createProject({ name: "Two", root: source })]);
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  const before = await readFile(registry, "utf8");
  await writeFile(`${registry}.lock`, "Another process");
  await expect(createProject({ name: "Other", root: await queueRoot("other") })).rejects.toMatchObject({ status: 409 });
  expect(await readFile(registry, "utf8")).toBe(before);
  expect(await readFile(`${registry}.lock`, "utf8")).toBe("Another process");
});
