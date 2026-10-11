/**
 * Retrying the failures that look like the pipeline rather than the branch.
 *
 * Kept apart from the survey because it is the only part of the read path that writes: it changes
 * Azure DevOps and the durable ledger, while everything around it merely decides.
 *
 * No regular expressions are used.
 */
import { requeuePolicy } from "./azure-devops.mjs";
import { classifyFailures } from "./build-failures.mjs";
import { rememberRequeue, writeJsonAtomic } from "./state.mjs";

/**
 * Requeue every transient failure on one pull request.
 *
 * The ledger is written before the call, not after. A requeue that succeeded but whose bookkeeping
 * was lost would be retried again next pass, and an endless retry loop is worse than one missed
 * retry: that loop is exactly how a real lint failure went unaddressed through several runs.
 */
export async function retryTransient({ config, state, pr, builds, retried, transientNames, ado, log }) {
  const { requeue } = classifyFailures(builds, { retried, transientNames });
  for (const build of requeue) {
    rememberRequeue(state, pr, build);
    if (config.stateFile) await writeJsonAtomic(config.stateFile, state);
    try {
      await (ado.requeuePolicy || requeuePolicy)(config, build.evaluationId, { prId: pr.id });
      await log("build_requeued", { pr: pr.id, build: build.id, name: build.name });
    } catch (error) {
      await log("build_requeue_failed", { pr: pr.id, build: build.id, error: String(error.message || error) });
    }
  }
}
