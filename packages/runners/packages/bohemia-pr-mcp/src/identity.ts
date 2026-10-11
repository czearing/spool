/// The calling agent is never a tool argument. Harness launches each agent's Copilot
/// process with CAIRN_HARNESS_AGENT=<worker id>, and a locally spawned MCP server
/// inherits that environment, so the sender is read rather than asserted.
export function callingAgent(environment: NodeJS.ProcessEnv = process.env): string {
  return (environment.CAIRN_HARNESS_AGENT || "").trim();
}

/// No agent id means Caleb is running the tool himself rather than an agent running
/// it for him, and a Discord message telling him about his own pull request is noise.
/// The pull request is still created; only the notification is skipped.
export function shouldNotify(environment: NodeJS.ProcessEnv = process.env): boolean {
  return callingAgent(environment).length > 0;
}
