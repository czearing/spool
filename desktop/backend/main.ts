import { createInterface } from "node:readline";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { format } from "node:util";
import { dispatch } from "./dispatch";

const write = process.stdout.write.bind(process.stdout);
console.log = (...args: unknown[]) => process.stderr.write(format(...args) + "\n");
const send = (id: string, frame: object) => write(JSON.stringify({ id, ...frame }) + "\n");
const pending = new Map<string, AbortController>();
type Input = { id: string; url: string; method: string; headers?: [string, string][]; body?: string; cancel?: boolean };
await mkdir(process.cwd(), { recursive: true });
try {
  const connections = JSON.parse(await readFile(join(process.cwd(), "connections.json"), "utf8"));
  for (const [key, value] of Object.entries(connections)) {
    if (!["SPOOL_PROJECTS_FILE", "SPOOL_RUNNERS_HOME", "SPOOL_RUNNERS_CONFIG", "SPOOL_AGENT_BINARY", "SPOOL_MONITOR_BRIDGE"].includes(key) ||
        typeof value !== "string" || !value) throw new Error("Invalid desktop connection setting.");
    process.env[key] = resolve(value);
  }
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
process.env.SPOOL_PROJECTS_FILE ??= join(process.cwd(), "projects.json");

async function execute(input: Input) {
  if (input.cancel) { pending.get(input.id)?.abort(); return; }
  const controller = new AbortController();
  pending.set(input.id, controller);
  try {
    if (!input.url.startsWith("/api/") || input.url.startsWith("//") ||
        !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(input.method)) throw new Error("Invalid desktop operation.");
    const headers = new Headers(input.headers);
    headers.set("host", "localhost"); headers.set("origin", "http://localhost");
    const request = new Request(`http://localhost${input.url}`, {
      method: input.method, headers, body: input.body, signal: controller.signal,
    });
    const response = await dispatch(request);
    send(input.id, { type: "head", status: response.status, headers: [...response.headers] });
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          send(input.id, { type: "chunk", body: Buffer.from(value).toString("base64") });
        }
      } finally { await reader.cancel(); }
    }
    send(input.id, { type: "end" });
  } catch (error) {
    console.error("Desktop operation failed:", input.url, error);
    send(input.id, { type: "error", error: error instanceof Error ? error.message : String(error) });
  } finally { pending.delete(input.id); }
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  try {
    const input: Input = JSON.parse(line);
    if (typeof input.id !== "string" || line.length > 2_000_000) throw new Error("Invalid desktop request envelope.");
    void execute(input);
  } catch (error) { console.error("Invalid desktop request:", error); }
});
lines.on("close", () => {
  for (const controller of pending.values()) controller.abort();
  process.exit(0);
});
send("ready", { type: "ready" });
