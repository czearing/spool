// Denies the shell commands that publish or reword an Azure DevOps pull request.
//
// Why this exists. The pull request tool refuses a change that fails the required checks or breaks
// the description template, but refusing is only half a gate: an agent holding a shell can open the
// same pull request itself, and one did. On 2026-08-25 bohemia_pr_create refused twice, once for
// wording and once because the gate could not run from a \\?\ working directory, and the agent
// concluded the tool was broken and ran `az repos pr create --description "placeholder"` followed by
// a REST PATCH carrying the real body. Pull request 5639404 is the result: unchecked wording, a
// ten word title, and none of the template's structure. The tool was fixed; the route around it was
// not, and an agent that has been burned once does not try the tool again.
//
// So the rule is enforced where the bypass lives rather than where the policy is written.
//
// Reads are never denied, and neither is work on anything beneath a pull request. An agent must
// still be able to see the pull requests it is repairing, answer and resolve review comment threads,
// upload the screenshots the template asks for, and cast a vote. None of those can open a pull
// request or choose its wording. Only the entity that owns the title and the description is closed.

import { pushScopes } from "./push-scope.ts";
import { text } from "node:stream/consumers";

export type Decision = { deny: boolean; reason?: string };

const SHELL_TOOLS = new Set(["powershell", "bash", "shell", "run_in_terminal", "execute"]);

/// Opening a pull request is never allowed by hand: there is no form of `az repos pr create` that
/// runs the required checks.
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
  if (!SHELL_TOOLS.has(toolName)) return { deny: false };

  const command = typeof args.command === "string" ? args.command : "";
  if (!command) return { deny: false };

  const pushes = pushScopes(command, cwd);
  if (pushes.includes("bohemia") || pushes.includes("unknown")) {
    return {
      deny: true,
      reason: pushes.includes("bohemia")
        ? "Direct `git push` to Office Bohemia is blocked until its required checks pass. " +
          "Use `bohemia push` (which runs `bohemia check` first, then pushes only if all gates pass) or " +
          "use `bohemia_pr_create` / `bohemia_pr_update`."
        : "The push destination could not be verified. Use a literal repository path and remote in a separate command.",
    };
  }

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
      `This command (${what}) opens or rewords a pull request without the required checks, ` +
      "so it was not run. Use the bohemia-pr tool instead: bohemia_pr_create to open one, " +
      "bohemia_pr_update to revise one. Both run the repository's required checks first and " +
      "build the title and description from the template, which a hand written call cannot do. " +
      "If the tool refuses, the refusal names what to fix; fix that and call it again rather " +
      "than publishing around it. Reading pull requests, answering and resolving review " +
      "comment threads, uploading attachments and voting are all unaffected.",
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
    const call =
      Array.isArray(event.toolCalls) && typeof event.toolCalls[0] === "object"
        ? (event.toolCalls[0] as Record<string, unknown>)
        : undefined;
    const toolName = (event.toolName ?? event.tool_name ?? call?.name ?? "") as string;
    const rawArgs = event.toolArgs ?? event.tool_input ?? call?.args;
    const args = (typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs) ?? {};
    decision = decide(toolName, args as Record<string, unknown>,
      typeof event.cwd === "string" ? event.cwd : process.cwd());
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
