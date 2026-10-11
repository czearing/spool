import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunnerCatalog } from "./runner-catalog";
import { runnerLocations } from "./runner-client";

vi.mock("./runner-client", () => ({ runnerLocations: vi.fn() }));
it("returns names directly from configuration without importing or probing the engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-catalog-"));
  try {
    const config = join(root, "spool-runners.json");
    vi.mocked(runnerLocations).mockReturnValue({ config, runtime: root, home: join(root, "missing-engine") });
    await writeFile(config, JSON.stringify({ spool_dir: root, pr_reviewer: { enabled: true, editor: { name: "Reviews" } },
      custom_runners: { "my-runner": { name: "My runner" } } }));
    expect(await readRunnerCatalog(root)).toEqual({ configured: true, runners: [
      { id: "pr-reviewer", name: "Reviews" }, { id: "my-runner", name: "My runner" },
    ] });
    await writeFile(join(root, "service.json"), JSON.stringify({ state: "error" }));
    expect((await readRunnerCatalog(root)).error).toContain("Runner service");
    const other = join(root, "other"); await mkdir(other);
    expect(await readRunnerCatalog(other)).toEqual({ configured: false, runners: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
