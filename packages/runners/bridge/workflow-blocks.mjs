import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { executeAction } from "./workflow-actions.mjs";
import { boundedJson, filterInput, mapJson, mapValue } from "./workflow-data.mjs";

const exec = promisify(execFile);
async function script(step, workflow, context) {
  const { stdout, stderr } = await (context.run || exec)(process.platform === "win32" ? "pwsh.exe" : "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; $PSNativeCommandUseErrorActionPreference=$true;\n${step.command}`],
    { cwd: workflow.workspace, windowsHide: true, timeout: 1800000, maxBuffer: 65536,
      env: { ...process.env, SPOOL_RUNNER_ID: workflow.id, SPOOL_INPUT: JSON.stringify(context.input) } });
  let output = stdout.trim();
  try { output = JSON.parse(output); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  return { output, preparation: undefined, diagnostics: stderr.slice(0, 4096) };
}
async function http(step, _workflow, context) {
  const mapped = mapValue(step.url, context);
  if (typeof mapped !== "string") throw new Error("HTTP URL must resolve to text.");
  const url = new URL(mapped);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP URL without embedded credentials.");
  const headers = { Accept: "application/json" }, method = step.method || "GET";
  if (step.bearerEnv) {
    const token = process.env[step.bearerEnv];
    if (!token) throw new Error(`Runner environment variable is not configured: ${step.bearerEnv}`);
    headers.Authorization = `Bearer ${token}`;
  }
  let body;
  if (step.body) {
    if (method === "GET") throw new Error("GET requests cannot have a body.");
    body = JSON.stringify(mapJson(step.body, context)); headers["Content-Type"] = "application/json";
  }
  const response = await (context.fetch || fetch)(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP request failed with status ${response.status}.`); }
  const reader = response.body?.getReader(), chunks = [];
  let size = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 60000) { await reader.cancel(); throw new Error("HTTP response exceeds 60,000 bytes."); }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const data = text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
  return { output: { status: response.status, body: data } };
}
const handlers = {
  command: script, http,
  data: async (step, _workflow, context) => ({ output: mapJson(step.body, context) }),
  filter: async (step, _workflow, context) => ({ output: context.input, filtered: !filterInput(step, context.input) }),
  repository: async (step, workflow, context) => executeAction(step, workflow, context),
  agent: async (step, workflow, context) => {
    const prompt = mapValue(step.prompt, context);
    if (typeof prompt !== "string") throw new Error("Task instructions must resolve to text.");
    return executeAction({ ...step, prompt }, workflow, context);
  },
};
export async function executeBlock(step, workflow, context) {
  const handler = handlers[step.kind];
  if (!handler) throw new Error(`Unsupported action: ${step.kind}`);
  const result = await handler(step, workflow, context);
  return { ...result, output: boundedJson(result.output ?? (result.taskId ? { taskId: result.taskId } : null)) };
}
