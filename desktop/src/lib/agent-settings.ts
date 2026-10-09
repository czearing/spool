export type AgentSettings = {
  name: string; description: string; icon: string; maxConcurrentRuns: number | null;
  model: string | null; defaultModel: string; revision: string; image: string | null;
};
export function isAgentImage(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length <= 65536 &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
export const agentIcons = ["bot", "code", "search", "shield", "pen-tool", "chart-line",
  "bug", "flask-conical", "workflow", "lightbulb", "terminal", "book-open"] as const;
export type AgentIconName = typeof agentIcons[number];
export function isAgentIcon(value: unknown): value is AgentIconName {
  return typeof value === "string" && agentIcons.some((icon) => icon === value);
}
export function isAgentSettings(value: unknown): value is AgentSettings {
  if (!value || typeof value !== "object") return false;
  return "name" in value && typeof value.name === "string" && "description" in value && typeof value.description === "string" &&
    "icon" in value && isAgentIcon(value.icon) && "image" in value && isAgentImage(value.image) &&
    "model" in value && (value.model === null || typeof value.model === "string") &&
    "defaultModel" in value && typeof value.defaultModel === "string" && "revision" in value && typeof value.revision === "string" &&
    "maxConcurrentRuns" in value && (value.maxConcurrentRuns === null ||
      typeof value.maxConcurrentRuns === "number" && Number.isSafeInteger(value.maxConcurrentRuns) && value.maxConcurrentRuns > 0);
}
