import { eventRecipe, type RunnerWorkflow } from "@spool/workflow";

export function managedFixture(id: string): RunnerWorkflow {
  const graph = eventRecipe(id, { agent: id === "pr-reviewer" ? "pr-reviewer" : "software-engineer", reviewer: "reviewer@example.invalid" });
  const inspection = Object.fromEntries(graph.nodes.map(node => [node.id, {
    context: {},
    ...(node.kind === "agent" ? {
      prompt: id === "pr-updater"
        ? "# PR update mode\nContinue the original task {{contract.identifier}} in {{contract.cwd}}.\nFixture preview: preserve the creator identity and independently verify the result."
        : `${id === "pr-reviewer" ? "Review pull request {{pr.id}}.\nSource commit: {{pr.sourceCommit}}" : "Livesite incident: {{incident.kind}}.\nEvidence: {{incident.summary}}"}
Prepared branch: {{prepared.branch}}.
Fixture preview: record evidence on the current Spool task.`,
      ...(id === "pr-updater" ? { agentSource: "Original creator's agent instructions; resolved for each PR." } :
        { agentSource: `Fixture agents\\${node.agent}.md`, agentInstructions: "# Fixture agent\nNever execute real work from Storybook." }),
    } : {}),
  }]));
  return { id, name: id, kind: "managed", enabled: true, workspace: id === "pr-updater" ? "" : "C:\\Work\\bohemia",
    intervalSeconds: 300, revision: "fixture-initial", ...graph, inspection };
}
