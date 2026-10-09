import { appFetch } from "../platform/request";
import type { AgentPrompt } from "./agents";
import { PromptSaveError } from "./prompt-sync";

export async function requestPrompt(url: string, init?: RequestInit): Promise<AgentPrompt> {
  const response = await appFetch(url, { cache: "no-store", ...init });
  const result: unknown = await response.json();
  if (!response.ok) {
    throw new PromptSaveError(result && typeof result === "object" && "error" in result && typeof result.error === "string"
      ? result.error : "Could not sync this prompt. Your draft is preserved.", response.status);
  }
  if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string" ||
    !("revision" in result) || typeof result.revision !== "string" ||
    !("prompt" in result) || typeof result.prompt !== "string") throw new Error("The server returned an invalid prompt.");
  return { id: result.id, prompt: result.prompt, revision: result.revision };
}
