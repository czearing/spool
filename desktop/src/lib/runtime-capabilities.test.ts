import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertActiveRuntimeSupports } from "./runtime-capabilities";

let root: string;
const now = Date.parse("2026-10-15T17:00:00Z");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-runtime-capability-"));
  await mkdir(join(root, "controls"));
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

for (const feature of ["projectModelVersion", "agentSettingsVersion", "sharedPromptsVersion"] as const) {
  it(`${feature}: allows local configuration without a task daemon`, async () => {
    await expect(assertActiveRuntimeSupports(root, feature)).resolves.toBeUndefined();
  });
  it.each([0, 14999, 15000, 15001])(`${feature}: checks incompatible runtime heartbeat age %i ms`, async age => {
    await writeFile(join(root, "controls", "capabilities.json"),
      JSON.stringify({ [feature]: 0, updatedAt: new Date(now - age).toISOString() }));
    if (age < 15000) await expect(assertActiveRuntimeSupports(root, feature)).rejects.toMatchObject({ status: 503 });
    else await expect(assertActiveRuntimeSupports(root, feature)).resolves.toBeUndefined();
  });
  it(`${feature}: allows a fresh compatible runtime`, async () => {
    await writeFile(join(root, "controls", "capabilities.json"),
      JSON.stringify({ [feature]: 1, updatedAt: new Date(now).toISOString() }));
    await expect(assertActiveRuntimeSupports(root, feature)).resolves.toBeUndefined();
  });
  it.each([{}, null, [], { updatedAt: "invalid" }, { updatedAt: new Date(now + 1).toISOString() }])(
    `${feature}: rejects invalid or future runtime capabilities: %j`, async value => {
      await writeFile(join(root, "controls", "capabilities.json"), JSON.stringify(value));
      await expect(assertActiveRuntimeSupports(root, feature)).rejects.toMatchObject({ status: 503 });
    });
}
it("does not silently treat a corrupt capability file as an offline daemon", async () => {
  await writeFile(join(root, "controls", "capabilities.json"), "{broken");
  await expect(assertActiveRuntimeSupports(root, "projectModelVersion")).rejects.toThrow(SyntaxError);
});
