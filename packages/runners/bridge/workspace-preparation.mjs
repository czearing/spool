import { setupAgentBranch } from "../packages/bohemia-agent-tooling/src/index.js";

export function createWorkspacePreparer({ store, queue, agent, workspace, call,
  prepare = options => options.prepared || setupAgentBranch(options) }) {
  return async options => {
    store.assertIdle(agent, workspace);
    const prepared = await prepare({ ...options, repoRoot: workspace, call });
    store.assertIdle(agent, workspace);
    queue.setPreparation(prepared);
    return prepared;
  };
}
