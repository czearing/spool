import { join } from "node:path";
import { AgentError } from "./agents";
import { readOptionalJson } from "./spool-publish";

const features = {
  projectModelVersion: "model settings",
  agentSettingsVersion: "agent settings",
  sharedPromptsVersion: "shared prompts",
} as const;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export async function assertActiveRuntimeSupports(root: string, feature: keyof typeof features) {
  const value = await readOptionalJson(join(root, "controls", "capabilities.json"));
  if (value === undefined) return;
  const capability = record(value) ? value : {};
  const age = "updatedAt" in capability && typeof capability.updatedAt === "string"
    ? Date.now() - Date.parse(capability.updatedAt) : NaN;
  if (Number.isFinite(age) && age >= 15000) return;
  if (capability[feature] !== 1 ||
    !Number.isFinite(age) || age < 0) {
    throw new AgentError(`The project's runtime capabilities do not confirm ${features[feature]} support. Update and restart the task runtime before continuing.`, 503);
  }
}
