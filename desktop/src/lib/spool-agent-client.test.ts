import { spawn } from "node:child_process";
import { join } from "node:path";
import { applicationPaths } from "./application-paths";
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
  expect(spawn).toHaveBeenLastCalledWith(join(applicationPaths().resources,
    `spool-engine${process.platform === "win32" ? ".exe" : ""}`),
  ["--root", "project", "mcp"], expect.objectContaining({ windowsHide: true }));
});

it("keeps the application-owned CLI when an obsolete environment override is present", async () => {
  vi.stubEnv("SPOOL_AGENT_BINARY", process.execPath);
  await expect(callAgentTool("project", "spool_get_agent", { name: "reader" })).rejects.toThrow("spawn intercepted");
  expect(spawn).toHaveBeenLastCalledWith(join(applicationPaths().resources,
    `spool-engine${process.platform === "win32" ? ".exe" : ""}`), ["--root", "project", "mcp"],
    expect.objectContaining({ windowsHide: true }));
});
