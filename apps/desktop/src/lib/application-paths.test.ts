import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { configureBackend } from "../../backend/configuration";
import { applicationPaths, configureApplication } from "./application-paths";
import { projectRegistryFile } from "./project-storage";
import { callAgentTool } from "./spool-agent-client";
import { runnerLocations } from "./runner-client";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => { throw new Error("Fixture: do not launch a process"); }) }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("uses explicit application paths regardless of obsolete connection files or environment overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "spool-paths-"));
  try {
    const resources = join(root, "resources"), project = join(root, "project");
    const obsolete = "{obsolete connection settings must not be read or migrated";
    await writeFile(join(root, "connections.json"), obsolete);
    for (const key of ["SPOOL_DATA_DIR", "SPOOL_PROJECTS_FILE", "SPOOL_AGENT_BINARY", "SPOOL_RUNNERS_HOME",
      "SPOOL_RUNNERS_CONFIG", "SPOOL_MONITOR_BRIDGE", "SPOOL_DESKTOP_TASK_RUNTIME"]) vi.stubEnv(key, "obsolete");
    configureApplication(await configureBackend(root, resources));
    expect(applicationPaths()).toEqual({ data: root, resources });
    expect(Object.isFrozen(applicationPaths())).toBe(true);
    expect(projectRegistryFile()).toBe(join(root, "projects.json"));
    expect(runnerLocations(project)).toEqual({ home: join(resources, "runners"),
      runtime: join(project, ".runner", "automation"), config: join(project, ".runner", "automation", "spool-runners.json") });
    await expect(callAgentTool(project, "fixture", {})).rejects.toThrow("Fixture: do not launch a process");
    expect(spawn).toHaveBeenCalledWith(join(resources, process.platform === "win32" ? "spool-engine.exe" : "spool-engine"),
      ["--root", project, "mcp"], expect.any(Object));
    expect(await readFile(join(root, "connections.json"), "utf8")).toBe(obsolete);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects relative application paths instead of guessing a sibling installation", async () => {
  const absolute = join(tmpdir(), "spool-paths");
  expect(() => configureApplication({ data: ".", resources: absolute })).toThrow("absolute");
  expect(() => configureApplication({ data: absolute, resources: "." })).toThrow("absolute");
  await expect(configureBackend(".", absolute)).rejects.toThrow("absolute");
  await expect(configureBackend(absolute, ".")).rejects.toThrow("absolute");
});
