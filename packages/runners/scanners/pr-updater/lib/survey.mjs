/**
 * One read-only look at every open pull request, and what it implies.
 *
 * Split out of the pipeline so the decision inputs can be assembled and tested on their own. This
 * module never dispatches and never touches the clone; the single write it performs is requeuing a
 * build that the fleet shows to be broken, which costs nobody a turn.
 *
 * No regular expressions are used.
 */
import { closeAutomatedThreads } from "./auto-close.mjs";
import { classifyThreads, learnedMachines, observeIdentities } from "./authorship.mjs";
import { needsAttention, transientPolicies } from "./build-failures.mjs";
import { approvalSummary } from "./merge-readiness.mjs";
import { retryTransient } from "./requeue.mjs";
import { requeuedFor } from "./state.mjs";
import { CONFLICT, evaluate, shouldSend } from "./triggers.mjs";

/**
 * Evaluate every open pull request and return the verdicts.
 *
 * Three phases, because two of the tests are fleet-wide rather than per pull request. Every pull
 * request's builds and threads are collected first; then a gate red on more than one branch is
 * treated as the pipeline being broken and is retried, while one red on a single branch is that
 * branch's own defect and goes straight to an agent; and the commenter census is built across all
 * of them at once, since an identity's behaviour is only visible over several pull requests.
 *
 * Builds are fetched for everything except a conflicted pull request. Skipping the fetch whenever
 * a cheaper signal already explained the pull request looked like a saving and was a bug: a review
 * comment outranks nothing, so a pull request with both a comment and a failing build had its
 * failure neither requeued nor ever seen. Only a conflict makes the build result genuinely moot.
 */
export async function survey({ config, state, now, ado, log = async () => {} }) {
  const prs = (await ado.listOwnPullRequests(config)).filter((pr) => !pr.isDraft);
  const buildsByPr = {};
  const threadsByPr = {};

  for (const pr of prs) {
    threadsByPr[pr.id] = await ado.listThreads(config, pr.id);
    const conflicted = evaluate({ pr, now, config })?.trigger === CONFLICT;
    buildsByPr[pr.id] = conflicted ? [] : await ado.listBuilds(config, pr.id);
  }

  const transientNames = transientPolicies(buildsByPr);
  const machines = learnedMachines(observeIdentities(prs, threadsByPr));
  const authorship = {
    machines,
    knownMachines: config.botAccounts || [],
    selfAccount: config.authorAccount || "",
    agencyAuthorId: config.agencyAuthorId || "",
  };

  const surveyed = [];
  for (const pr of prs) {
    const builds = buildsByPr[pr.id];
    const threads = threadsByPr[pr.id];
    const retried = requeuedFor(state, pr);
    const isMyShard =
      !config.shard ||
      typeof config.shard.total !== "number" ||
      typeof config.shard.index !== "number" ||
      Number(pr.id) % config.shard.total === config.shard.index;
    if (isMyShard) await retryTransient({ config, state, pr, builds, retried, transientNames, ado, log });

    const approval = approvalSummary(pr);
    const cleared = isMyShard ? await closeAutomatedThreads({
      config, pr, threads, approvals: approval.approvals, ado, log, options: authorship,
    }) : { closed: 0, reason: "managed by the owning shard" };
    // Re-read after closing, so the dashboard never shows an unresolved count this pass just fixed.
    const currentThreads = cleared.closed > 0 ? await ado.listThreads(config, pr.id) : threads;
    const counts = classifyThreads(currentThreads, authorship);

    const verdict = evaluate({ pr, threads: currentThreads, builds, now, config, retried, transientNames });
    const infrastructure = builds.filter(build => build.failureKind === "infrastructure");
    const unavailable = builds.filter(build => build.failureKind === "unavailable");
    surveyed.push({
      pr,
      builds,
      threads: currentThreads,
      approval,
      counts,
      autoClose: cleared,
      verdict,
      holdingReason: !verdict && unavailable.length
        ? `CI evidence unavailable: ${unavailable.map(build => build.failureReason).join(" ")} No code-repair dispatch from missing evidence.`
        : !verdict && infrastructure.length
        ? `CI infrastructure blocked: ${infrastructure.map(build => build.name).join(", ")}. Remote agents did not connect; no code-repair dispatch.`
        : !verdict && builds.some(needsAttention) ? "Awaiting requeued CI validation" : null,
      send: isMyShard ? shouldSend(verdict, state.pullRequests?.[pr.id], now, config) : null,
    });
  }
  return surveyed;
}
