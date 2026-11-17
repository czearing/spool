import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import application from "../src-tauri/tauri.conf.json" with { type: "json" };
import type { ApplicationPaths } from "../src/lib/application-paths";

export function applicationData() {
  const base = process.platform === "win32" ? process.env.APPDATA
    : process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
      : process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  if (!base) throw new Error("Application data directory is unavailable.");
  return join(base, application.identifier);
}
export async function configureBackend(directory: string, resources: string): Promise<ApplicationPaths> {
  if (!isAbsolute(directory) || !isAbsolute(resources)) {
    throw new Error("Application data and resources must be absolute directories.");
  }
  await mkdir(directory, { recursive: true });
  return { data: directory, resources };
}
