/**
 * Durable state for the updater.
 *
 * The monitor's reader whitelists its own three keys and silently drops everything else, which
 * cost a live run: the record of what had already been sent never survived a pass, so the same
 * pull request was dispatched every cycle and every failing build was requeued forever. Rather
 * than widen a shape the monitor depends on, the updater keeps its own keys and reuses only the
 * atomic write.
 *
 * No regular expressions are used.
 */
import { readFile } from "node:fs/promises";
export { writeRunnerJsonAsync as writeJsonAtomic } from "../../../packages/bohemia-agent-tooling/src/index.js";

/** The empty shape, so a first run and a corrupt file behave identically. */
function empty() {
  return { pullRequests: {}, builds: {} };
}

function objectOr(value, fallback) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

/**
 * Read state, tolerating a missing or unreadable file.
 *
 * A parse failure starts over rather than throwing. Losing the send history costs one duplicate
 * task, which the harness discards by submission id anyway; refusing to start costs every pull
 * request until somebody notices.
 */
export async function readState(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return {
      pullRequests: objectOr(value.pullRequests, {}),
      builds: objectOr(value.builds, {}),
    };
  } catch {
    return empty();
  }
}

/**
 * The retry ledger for one pull request: policy identity to the build id already requeued.
 *
 * Scoped to the source commit, so a push clears the history: a failure on new code has never been
 * retried, whatever happened to the code it replaced. Keyed on the policy rather than the build,
 * because a requeue produces a new build with a new id and keying on that made every retry look
 * like a first sighting.
 */
export function requeuedFor(state, pr) {
  const entry = state.builds?.[pr.id];
  return entry?.commit === pr.sourceCommit ? entry.retried || {} : {};
}

export function rememberRequeue(state, pr, build) {
  state.builds ??= {};
  const existing = state.builds[pr.id];
  const entry = existing?.commit === pr.sourceCommit ? existing : { commit: pr.sourceCommit, retried: {} };
  entry.retried ??= {};
  entry.retried[String(build.evaluationId || build.name || build.id)] = build.id;
  state.builds[pr.id] = entry;
}
