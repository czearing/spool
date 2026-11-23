import { createInterface } from "node:readline";
import { format } from "node:util";
import { dispatch } from "./dispatch";
import { configureBackend } from "./configuration";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configureApplication } from "../src/lib/application-paths";
import { projectRegistryFile } from "../src/lib/project-storage";
import { closeBoardReadModels } from "../src/lib/board-read-model";

const write = process.stdout.write.bind(process.stdout);
console.log = (...args: unknown[]) => process.stderr.write(format(...args) + "\n");
const send = (id: string, frame: object) => write(JSON.stringify({ id, ...frame }) + "\n");
const pending = new Map<string, AbortController>();
type Input = { id: string; url: string; method: string; headers?: [string, string][]; body?: string; cancel?: boolean };
const paths = await configureBackend(process.cwd(), dirname(fileURLToPath(import.meta.url)));
configureApplication(paths);
if (process.argv.includes("--runner-service")) {
  const { startRunnerService } = await import(pathToFileURL(join(paths.resources, "runners", "bridge", "application-service.mjs")).href);
  const service = await startRunnerService(projectRegistryFile());
  if (!service) process.exit(0);
  let shutdown: Promise<void> | undefined;
  const stop = () => shutdown ??= service.stop().then(() => process.exit(0), (error: unknown) => {
    console.error("Runner service shutdown failed:", error); process.exit(1);
  });
  const controls = createInterface({ input: process.stdin, crlfDelay: Infinity });
  controls.on("line", line => { if (line === "shutdown") void stop(); });
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
} else {
let shutdown: Promise<void> | undefined;
const stop = () => shutdown ??= (async () => {
  for (const controller of pending.values()) controller.abort();
  await closeBoardReadModels();
  process.exit(0);
})();

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
    if ("shutdown" in input) { void stop().catch(error => { console.error("Runner shutdown failed:", error); process.exit(1); }); return; }
    if (typeof input.id !== "string" || line.length > 2_000_000) throw new Error("Invalid desktop request envelope.");
    void execute(input);
  } catch (error) { console.error("Invalid desktop request:", error); }
});
lines.on("close", () => { void stop(); });
send("ready", { type: "ready" });
}
