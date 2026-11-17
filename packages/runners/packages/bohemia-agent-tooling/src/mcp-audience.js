export const agentMcp = (environment = process.env) =>
  environment.REPOSITORY_MCP_AUDIENCE !== "automation";

// Older transports may import this while the shared runtime refreshes.
export function requireAgentPublication() {}
