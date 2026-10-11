import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunners, runnerLocations } from "./runner-client";

it("reads runner status directly without waiting for a child process to exit", async () => {
  const home = await mkdtemp(join(tmpdir(), "spool-runner-reader-"));
  const previous = process.env.SPOOL_RUNNERS_HOME;
  const config = process.env.SPOOL_RUNNERS_CONFIG;
  try {
    await mkdir(join(home, "bridge"));
    await writeFile(join(home, "spool-runners.json"), "{}");
    await writeFile(join(home, "bridge", "runner-snapshot.mjs"), `
      export async function runnerSnapshot(config, root, runners) {
        if (!runners.endsWith("runners")) throw new Error("Wrong runtime root");
        return { checkedAt: new Date().toISOString(), configured: true, runners: [] };
      }
    `);
    process.env.SPOOL_RUNNERS_HOME = home;
    delete process.env.SPOOL_RUNNERS_CONFIG;
    expect((await readRunners(home, true)).configured).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.SPOOL_RUNNERS_HOME; else process.env.SPOOL_RUNNERS_HOME = previous;
    if (config === undefined) delete process.env.SPOOL_RUNNERS_CONFIG; else process.env.SPOOL_RUNNERS_CONFIG = config;
    await rm(home, { recursive: true, force: true });
  }
});

it("keeps project configuration and execution state separate while sharing the installed engine", async () => {
  const home = await mkdtemp(join(tmpdir(), "spool-runner-projects-"));
  const previous = process.env.SPOOL_RUNNERS_HOME, config = process.env.SPOOL_RUNNERS_CONFIG;
  try {
    process.env.SPOOL_RUNNERS_HOME = home;
    process.env.SPOOL_RUNNERS_CONFIG = join(home, "legacy.json");
    const project = join(home, "project"), runtime = join(project, ".runner", "automation");
    expect(runnerLocations(project)).toEqual({ home, config: join(home, "legacy.json"), runtime: home });
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "spool-runners.json"), "{}");
    expect(runnerLocations(project)).toEqual({ home, config: join(runtime, "spool-runners.json"), runtime });
    expect(runnerLocations(join(home, "other"))).toEqual({ home, config: join(home, "legacy.json"), runtime: home });
  } finally {
    if (previous === undefined) delete process.env.SPOOL_RUNNERS_HOME; else process.env.SPOOL_RUNNERS_HOME = previous;
    if (config === undefined) delete process.env.SPOOL_RUNNERS_CONFIG; else process.env.SPOOL_RUNNERS_CONFIG = config;
    await rm(home, { recursive: true, force: true });
  }
});
