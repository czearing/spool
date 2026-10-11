import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/// Credentials stay in the existing Discord server's environment file rather than
/// being copied here, so there is one place to rotate them.
export function loadDiscordEnvironment() {
  const candidates = [
    process.env.BOHEMIA_PR_DISCORD_ENV,
    join("C:", "Code", "discord-mcp", ".env"),
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(match[1] in process.env)) process.env[match[1]] = value;
    }
    return;
  }
}

const AGENT_NAMES: Record<string, string> = {
  "pr-reviewer": "PR Reviewer",
  "livesite-agent": "Livesite",
  "repo-1-developer": "Bohemia Developer",
};

export function agentName(agent: string): string {
  const normalized = agent.trim().toLowerCase();
  if (AGENT_NAMES[normalized]) return AGENT_NAMES[normalized];
  return normalized
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export async function sendPullRequestLink(input: {
  agent: string;
  title: string;
  url: string;
  action: "opened" | "updated";
}): Promise<string> {
  const webhook = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhook) return "skipped: DISCORD_WEBHOOK_URL is not configured";
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: agentName(input.agent),
      embeds: [
        {
          title: `Pull request ${input.action}`,
          description: `[${input.title}](${input.url})`,
          color: input.action === "opened" ? 0x2f81f7 : 0x8957e5,
          footer: { text: input.agent },
        },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok ? "sent" : `failed: Discord returned ${response.status}`;
}
