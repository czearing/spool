import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { callAgentTool } from "./spool-agent-client";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
beforeEach(() => {
  vi.stubEnv("SPOOL_AGENT_BINARY", undefined);
  vi.mocked(spawn).mockImplementation(() => { throw new Error("spawn intercepted"); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("resolves the development CLI relative to its source, not the working directory", async () => {
  vi.spyOn(process, "cwd").mockReturnValue("unrelated-working-directory");
  await expect(callAgentTool("project", "spool_get_agent", { name: "reader" })).rejects.toThrow("spawn intercepted");
  expect(spawn).toHaveBeenLastCalledWith(fileURLToPath(new URL(
    `../../../target/release/spool${process.platform === "win32" ? ".exe" : ""}`, import.meta.url)),
  ["--root", "project", "mcp"], expect.objectContaining({ windowsHide: true }));
});

it("uses an explicitly configured CLI instead of the development default", async () => {
  vi.stubEnv("SPOOL_AGENT_BINARY", process.execPath);
  await expect(callAgentTool("project", "spool_get_agent", { name: "reader" })).rejects.toThrow("spawn intercepted");
  expect(spawn).toHaveBeenLastCalledWith(process.execPath, ["--root", "project", "mcp"],
    expect.objectContaining({ windowsHide: true }));
});
