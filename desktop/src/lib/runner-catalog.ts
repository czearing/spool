import { readFile, realpath } from "node:fs/promises";
import { managedIds } from "@spool/workflow";
import { runnerLocations } from "./runner-client";
import { hasCode } from "./file-snapshot";
import { join } from "node:path";
import type { RunnerCatalog } from "./runners";

export type { RunnerCatalog } from "./runners";
export async function readRunnerCatalog(root: string): Promise<RunnerCatalog> {
  const { config, runtime } = runnerLocations(root);
  try {
    const value = JSON.parse(await readFile(config, "utf8"));
    const physical = async (path: string) => {
      const resolved = await realpath(path);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    if (await physical(value.spool_dir) !== await physical(root)) return { configured: false, runners: [] };
    const runners = [
      ...managedIds.filter(id => Object.hasOwn(value, id.replaceAll("-", "_")))
        .map(id => ({ id, name: value[id.replaceAll("-", "_")].editor?.name || id })),
      ...Object.entries(value.custom_runners || {}).map(([id, row]) => {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !row || typeof row !== "object" ||
            !("name" in row) || typeof row.name !== "string") throw new Error("Invalid runner configuration.");
        return { id, name: row.name };
      }),
    ];
    let error: string | undefined;
    try {
      const service = JSON.parse(await readFile(join(runtime, "service.json"), "utf8"));
      if (service.state === "error") error = "Runner service could not apply its configuration. Check the application log.";
      if (service.state === "stopped") error = "Runner service is stopped. Open Spool to start your runners.";
      if (service.state === "stopping") error = "Runner service is finishing active work before stopping.";
    } catch (reason) { if (!hasCode(reason, "ENOENT")) throw reason; }
    return { configured: true, runners, ...(error ? { error } : {}) };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { configured: false, runners: [] };
    console.error("Cannot read runner catalog.", error);
    return { configured: false, runners: [], error: "Runner configuration could not be read." };
  }
}
