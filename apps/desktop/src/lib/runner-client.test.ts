import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureApplication } from "./application-paths";
import { readRunners, runnerLocations } from "./runner-client";

it("reads project runner status directly from the bundled engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "spool-runner-reader-"));
  const resources = join(root, "resources"), home = join(resources, "runners");
  try {
    configureApplication({ data: root, resources });
    await mkdir(join(home, "bridge"), { recursive: true });
    await mkdir(join(root, ".runner", "automation"), { recursive: true });
    await writeFile(join(root, ".runner", "automation", "spool-runners.json"), "{}");
    await writeFile(join(home, "bridge", "runner-snapshot.mjs"), `
      export async function runnerSnapshot(config, root, runners) {
        if (!runners.endsWith("runners")) throw new Error("Wrong runtime root");
        return { checkedAt: new Date().toISOString(), configured: true, runners: [] };
      }
    `);
    expect((await readRunners(root, true)).configured).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("always isolates project configuration and state without a global fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "spool-runner-projects-"));
  const resources = join(root, "resources"), home = join(resources, "runners");
  try {
    configureApplication({ data: root, resources });
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "spool-runners.json"), "{}");
    for (const name of ["project", "other"]) {
      const project = join(root, name), runtime = join(project, ".runner", "automation");
      expect(runnerLocations(project)).toEqual({ home, config: join(runtime, "spool-runners.json"), runtime });
      expect((await readRunners(project, true)).configured).toBe(false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
