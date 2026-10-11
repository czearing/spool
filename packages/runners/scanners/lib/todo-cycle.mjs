export async function runTodoCycle({ config, queue, prepare, holding, scan, buildCycleConfig, runCycle }) {
  const built = buildCycleConfig({ argv: [], engineConfig: config, queue, env: {} });
  built.todoJsonPath = config.todoJsonPath;
  built.todoMetadata = { scan, dispatchHolding: holding };
  built.setupAgentBranch = prepare;
  built.failOnCollectionError = true;
  if (holding) {
    const select = built.selector;
    built.selector = observations => ({ ...select(observations), candidate: null, reason: "dispatch_held" });
    built.correctBriefs = false;
    // Retain the docs watermark so held work is reconsidered once the agent is available.
    if (built.gate) built.gate = { ...built.gate, commit() {} };
  }
  const result = await runCycle(built);
  if (result.failures?.length) throw new Error(`Collection failed: ${JSON.stringify(result.failures)}`);
  return { dispatched: Number(!!result.issueId), taskId: result.issueId,
    observed: result.observations.length, reason: result.selection.reason };
}
