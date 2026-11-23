import { CopilotClient } from "@github/copilot-sdk";
import { copilotRuntimePath } from "./copilot-runtime";

export type ModelOption = { value: string; label: string };
let cached: { expires: number; models: Promise<ModelOption[]> } | undefined;

async function closeDiscovery(client: CopilotClient) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const errors = await Promise.race([client.stop(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Model discovery cleanup timed out.")), 2000);
    })]);
    if (errors.length) throw new AggregateError(errors, "Model discovery cleanup failed.");
  } catch (error) {
    console.error("Could not cleanly close model discovery.", error);
    try { await client.forceStop(); }
    catch (error) { console.error("Could not stop the model discovery client.", error); }
  } finally { clearTimeout(timer); }
}
async function loadModels(): Promise<ModelOption[]> {
  const client = new CopilotClient({ connection: { kind: "stdio", path: copilotRuntimePath() } });
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
    await closeDiscovery(client);
  }
}
export function getModelCatalog() {
  if (!cached || cached.expires < Date.now()) {
    const models = loadModels().catch((error) => { cached = undefined; throw error; });
    cached = { expires: Date.now() + 300000, models };
  }
  return cached.models;
}
