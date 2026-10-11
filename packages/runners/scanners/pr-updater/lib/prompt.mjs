/**
 * The task body sent to the updater.
 *
 * Deliberately tiny. The agent's standing prompt is injected on the same turn and already carries
 * every duty, rule and method, so anything restated here is paid for twice in tokens and competes
 * with the prompt for attention. This message carries only what the prompt cannot know: which
 * pull request, what changed, and where the clone is.
 *
 * Nothing about tooling, watch scripts or how the work was detected appears here. None of it
 * changes what the agent does. No regular expressions are used.
 */
import { AGENCY, BUILD, CONFLICT, REVIEW } from "./triggers.mjs";

/** One line naming the cause, in the fewest words that still locate the problem. */
function causeLine(verdict, prepared) {
  if (verdict.trigger === CONFLICT) {
    const files = prepared?.merge?.files || [];
    return files.length > 0 ? `Conflicts: ${files.join(", ")}` : "Merge conflict";
  }
  if (verdict.trigger === BUILD) return verdict.reason;
  if (verdict.trigger === REVIEW) return verdict.reason;
  if (verdict.trigger === AGENCY) return verdict.reason;
  return verdict.reason || "Needs attention";
}

/**
 * Build the message.
 *
 * The clone line appears only when the tree was positioned for this job, because the agent is
 * forbidden from checking out anything itself and would otherwise have no way to know the branch
 * moved. When nothing was prepared, saying nothing is correct: the agent's prompt names its clone.
 */
export function taskBody(verdict, options = {}) {
  const { pr, prepared = null } = options;
  const lines = [`PR ${pr.id}`, pr.url].filter(Boolean);
  lines.push(causeLine(verdict, prepared));
  if (prepared?.branch) {
    const served = prepared.server?.url ? `, served at ${prepared.server.url}` : "";
    lines.push(`${prepared.branch} is checked out and verified clean${served}. Do not run an upfront baseline check; proceed directly to addressing the feedback.`);
  }
  return lines.join("\n");
}

/**
 * A stable id for one cause on one pull request.
 *
 * The harness derives its task id from this and inserts with ON CONFLICT DO NOTHING, so a reused
 * id is silently dropped and a needlessly unique one re-sends work the agent already has. The
 * fingerprint identifies the evidence, which is exactly the granularity wanted; the retry counter
 * lets a still-unresolved cause be offered again without colliding with its first delivery.
 */
export function submissionId(projectId, prId, fingerprint, attempt = 0) {
  const safe = String(fingerprint).split(":").join("-");
  return `${projectId}:pr-updater:${prId}:${safe}:${attempt}`;
}
