import { spawn } from "node:child_process";
import { join } from "node:path";
import { runnerLocations } from "./runner-client";
import { isRunnerWorkflow, type RunnerWorkflow } from "./runner-workflow";

export class RunnerWorkflowError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export async function runnerWorkflowRequest(root: string, id: string, method: string, input?: unknown): Promise<RunnerWorkflow> {
  const value = await runnerRequest(root, id, method, input);
  if (!isRunnerWorkflow(value)) throw new Error("Invalid runner settings response.");
  return value;
}
export function runnerRequest(root: string, id: string, method: string, input?: unknown): Promise<unknown> {
  const { home, config } = runnerLocations();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(home, "bridge", "workflow-cli.mjs"), config, root, id, method],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, SPOOL_RUNNERS_HOME: home } });
    let output = "", diagnostics = "", settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => { child.kill(); fail(new Error("Runner settings request timed out.")); }, 15000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 5000000) { child.kill(); fail(new Error("Runner response is too large.")); }
    });
    child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
    child.on("close", () => {
      if (settled) return;
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (result.error) throw new RunnerWorkflowError(result.error, result.status || 503);
        settled = true; resolve(result.value);
      } catch (error) {
        if (diagnostics) console.error("Runner settings:", diagnostics);
        fail(error instanceof Error ? error : new Error("Runner settings failed."));
      }
    });
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}
