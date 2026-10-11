import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Child MCP workers and PowerShell gates must not use the operator's logs or caches.
export const testHome = mkdtempSync(join(tmpdir(), "bohemia-test-home-"));
process.env.USERPROFILE = testHome;
process.env.HOME = testHome;
process.env.BOHEMIA_MCP_RUNTIME = process.execPath;
process.env.COPILOT_SESSION_ID = `fixture-${process.pid}`;
process.env.BOHEMIA_GATE_TEST_NAMESPACE = basename(testHome);
process.on("exit", () => rmSync(testHome, { recursive: true, force: true, maxRetries: 3 }));
