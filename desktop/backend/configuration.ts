import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import application from "../src-tauri/tauri.conf.json" with { type: "json" };

export function applicationData() {
  if (process.env.SPOOL_DATA_DIR) {
    if (!isAbsolute(process.env.SPOOL_DATA_DIR)) throw new Error("SPOOL_DATA_DIR must be an absolute directory.");
    return process.env.SPOOL_DATA_DIR;
  }
  const base = process.platform === "win32" ? process.env.APPDATA
    : process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
      : process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  if (!base) throw new Error("Application data directory is unavailable.");
  return join(base, application.identifier);
}
export async function configureBackend(directory: string) {
  await mkdir(directory, { recursive: true });
  try {
    const connections: unknown = JSON.parse(await readFile(join(directory, "connections.json"), "utf8"));
    if (!connections || typeof connections !== "object" || Array.isArray(connections)) throw new Error("Invalid connection settings.");
    for (const [key, value] of Object.entries(connections)) {
      if (!["SPOOL_PROJECTS_FILE", "SPOOL_RUNNERS_HOME", "SPOOL_RUNNERS_CONFIG", "SPOOL_AGENT_BINARY", "SPOOL_MONITOR_BRIDGE"].includes(key) ||
        typeof value !== "string" || !value) throw new Error("Invalid desktop connection setting.");
      process.env[key] = resolve(value);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  process.env.SPOOL_PROJECTS_FILE ??= join(directory, "projects.json");
}
