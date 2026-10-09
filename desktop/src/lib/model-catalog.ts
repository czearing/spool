import { CopilotClient } from "@github/copilot-sdk";
import { stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { hasCode } from "./file-snapshot";

export type ModelOption = { value: string; label: string };
let cached: { expires: number; models: Promise<ModelOption[]> } | undefined;

async function cliPath() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const relative of process.platform === "win32"
      ? ["copilot.exe", join("node_modules", "@github", "copilot", "npm-loader.js")] : ["copilot"]) {
      const path = join(/* turbopackIgnore: true */ directory, relative);
      try { if ((await stat(/* turbopackIgnore: true */ path)).isFile()) return path; }
      catch (error) { if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTDIR")) throw error; }
    }
  }
  throw new Error("Copilot CLI was not found on the server PATH.");
}
async function loadModels(): Promise<ModelOption[]> {
  const client = new CopilotClient({ connection: { kind: "stdio", path: await cliPath() } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = await Promise.race([client.start().then(() => client.listModels()), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Copilot model discovery timed out.")), 20000);
    })]);
    const available = models.filter((model) => model.policy?.state !== "disabled")
      .map((model) => ({ value: model.id, label: model.name }));
    if (!available.length) throw new Error("Copilot returned no available models.");
    return available;
  } finally {
    clearTimeout(timer);
    const errors = await client.stop();
    if (errors.length) console.error("Could not cleanly close model discovery.", errors);
  }
}
export function getModelCatalog() {
  if (!cached || cached.expires < Date.now()) {
    const models = loadModels().catch((error) => { cached = undefined; throw error; });
    cached = { expires: Date.now() + 300000, models };
  }
  return cached.models;
}
