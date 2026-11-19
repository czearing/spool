// Only PR wording is routed through the format functions. Repository work and pushes are unrestricted.

import { text } from "node:stream/consumers";

export type Decision = { deny: boolean; reason?: string };

const SHELL_TOOLS = new Set(["powershell", "bash", "shell", "run_in_terminal", "execute"]);

/// Creation writes the description as well as opening the PR.
const CREATE = /\baz\s+repos\s+pr\s+create\b/i;

/// `az repos pr update` also sets draft, auto-complete and abandonment, none of which touch wording,
/// and the draft flag in particular has to be set this way because it is dropped at create time. So
/// only the wording flags are refused.
const UPDATE = /\baz\s+repos\s+pr\s+update\b/i;
const WORDING_FLAG = /--(title|description)\b/i;

/// An HTTP write, wherever the flag sits. The previous form required the method to appear textually
/// before the URL, so simply moving `--url` ahead of `--method` walked straight past it.
const REST_WRITE = /(--method|-Method|-X)[\s=]*["']?(post|patch|put)\b/i;

/// The pull request entity or the collection that creates one: `pullRequests`, or `pullRequests/<id>`
/// with nothing addressed beneath it. A further path segment means a sub-resource, and those are the
/// repair agent's day job rather than a bypass: `/threads` and `/comments` answer and resolve review
/// comments, `/attachments` carries the before-and-after screenshots the template asks for,
/// `/reviewers` casts votes. None of them can open a pull request or choose its wording, and denying
/// them would break the agents that repair pull requests, so the line is drawn at the entity that
/// owns the title and the description.
const PR_ENTITY = /pullrequests?(\/\d+)?(?![/\w])/i;

export function decide(toolName: string, args: Record<string, unknown>, cwd = process.cwd()): Decision {
  if (Array.isArray(args.tool_uses)) {
    for (const call of args.tool_uses) {
      if (!call || typeof call.recipient_name !== "string" || !call.parameters) continue;
      const decision = decide(call.recipient_name, call.parameters, cwd);
      if (decision.deny) return decision;
    }
  }
  toolName = toolName.split(".").at(-1) || toolName;
  if (!SHELL_TOOLS.has(toolName)) return { deny: false };

  const command = typeof args.command === "string" ? args.command : "";
  if (!command) return { deny: false };

  const what = CREATE.test(command)
    ? "az repos pr create"
    : UPDATE.test(command) && WORDING_FLAG.test(command)
      ? "az repos pr update with --title or --description"
      : REST_WRITE.test(command) && PR_ENTITY.test(command)
        ? "a POST, PATCH or PUT to the pull request itself"
        : undefined;
  if (!what) return { deny: false };

  return {
    deny: true,
    reason:
      `This command (${what}) bypasses the PR description format. ` +
      "Use the repository createPullRequest/updatePullRequest functions, or run " +
      "node <repository-tools>/src/run.mjs pr <1js|bohemia> <input.json>. " +
      "These enforce the description template only; preparation receipts, builds, tests and pushes are not prerequisites.",
  };
}

/// The hook contract: read the event on stdin, print a decision, and stay silent otherwise. Copilot
/// treats a preToolUse command hook as fail-closed, so anything unexpected here would deny every
/// tool call in every session. Nothing below is allowed to throw.
// The timeout is a safety net for a caller that never closes stdin, but the timer must be cleared
// once the read wins. An uncancelled timer keeps the event loop alive, so the process lingered for
// the full 2s on every tool call even though the payload arrived in ~10ms.
async function readEvent(timeoutMs = 2000): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      text(process.stdin),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(""), timeoutMs);
      }),
    ]);
  } catch {
    return "";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const raw = await readEvent();

  let decision: Decision = { deny: false };
  try {
    const event = JSON.parse(raw) as Record<string, unknown>;
    const calls = Array.isArray(event.toolCalls) ? event.toolCalls : [{
      name: event.toolName ?? event.tool_name ?? "", args: event.toolArgs ?? event.tool_input,
    }];
    for (const call of calls) {
      if (!call || typeof call !== "object") continue;
      const args = (typeof call.args === "string" ? JSON.parse(call.args) : call.args) ?? {};
      decision = decide(typeof call.name === "string" ? call.name : "", args,
        typeof event.cwd === "string" ? event.cwd : process.cwd());
      if (decision.deny) break;
    }
  } catch {
    decision = { deny: false };
  }

  console.log(
    JSON.stringify(
      decision.deny
        ? { permissionDecision: "deny", permissionDecisionReason: decision.reason }
        : {},
    ),
  );
}

if (import.meta.main) await main();
