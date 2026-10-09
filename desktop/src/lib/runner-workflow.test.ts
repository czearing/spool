import { describe, expect, it } from "vitest";
import { isRunnerWorkflow, newRunnerWorkflow, workflowError } from "./runner-workflow";
import { insertWorkflowStep, nodeCatalog, removeWorkflowStep } from "./runner-node-catalog";

const choice = (id: string) => nodeCatalog.find(node => node.id === id)!;
function sample() {
  const value = insertWorkflowStep(insertWorkflowStep(newRunnerWorkflow(), choice("schedule")), choice("command"));
  value.workspace = "C:\\Work";
  value.nodes[1].command = "Write-Output 'test'";
  return value;
}
describe("runner workflow", () => {
  it("starts disabled and lets the user choose a trigger instead of forcing a script", () => {
    const value = newRunnerWorkflow();
    expect(value.enabled).toBe(false);
    expect(value.nodes).toEqual([]);
    expect(isRunnerWorkflow(value)).toBe(true);
    expect(workflowError(value)).toMatch(/directory/);
  });
  it("inserts typed actions between nodes and reconnects after removal", () => {
    const value = sample(), trigger = value.nodes[0];
    const changed = insertWorkflowStep(value, choice("refresh"), trigger.id), added = changed.nodes.at(-1)!;
    expect(added.operation).toBe("refresh");
    expect(added.position.x - trigger.position.x).toBe(224);
    expect(changed.edges.find(edge => edge.source === trigger.id)?.target).toBe(added.id);
    expect(workflowError(changed)).toBeUndefined();
    expect(workflowError(removeWorkflowStep(changed, added.id))).toBeUndefined();
  });
  it("switches triggers without losing connections and validates typed fields", () => {
    const value = insertWorkflowStep(sample(), choice("file-change"));
    expect(workflowError(value)).toMatch(/file to watch/);
    value.nodes[0].path = "book.md";
    expect(workflowError(value)).toBeUndefined();
    const next = insertWorkflowStep(value, choice("agent"));
    expect(workflowError(next)).toMatch(/agent/);
    next.nodes.at(-1)!.agent = "editor"; next.nodes.at(-1)!.prompt = "Review";
    expect(workflowError(next)).toBeUndefined();
  });
  it("validates real configuration, not a success-shaped empty script", () => {
    const value = sample();
    expect(workflowError(value)).toBeUndefined();
    value.nodes[1].command = "";
    expect(workflowError(value)).toMatch(/PowerShell command/);
  });
  it("rejects disconnected graphs, loops and invalid intervals", () => {
    const value = sample();
    value.edges = [];
    expect(workflowError(value)).toMatch(/sequence/);
    value.intervalSeconds = NaN;
    expect(workflowError(value)).toMatch(/interval/);
    expect(isRunnerWorkflow({ ...value, nodes: [{ id: 42 }] })).toBe(false);
  });
});
