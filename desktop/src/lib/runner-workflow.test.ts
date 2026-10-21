import { describe, expect, it } from "vitest";
import { eventRecipe } from "@spool/workflow";
import { isRunnerWorkflow } from "./runner-workflow";

const workflow = { id: "pr-updater", name: "pr-updater", kind: "managed", enabled: true, workspace: "",
  intervalSeconds: 300, revision: "fixture", ...eventRecipe("pr-updater") };
describe("runner API payload validation", () => {
  it("accepts the existing native updater contract without adding UI configuration", () => {
    expect(isRunnerWorkflow(workflow)).toBe(true);
    expect(workflow.nodes.at(-1)?.operation).toBe("resume-event");
  });
  it("rejects malformed node and edge payloads", () => {
    expect(isRunnerWorkflow({ ...workflow, nodes: [{ id: 42 }] })).toBe(false);
    expect(isRunnerWorkflow({ ...workflow, nodes: [{ ...workflow.nodes[0], kind: "invented" }] })).toBe(false);
    expect(isRunnerWorkflow({ ...workflow, edges: [{ source: 1, target: "node-2" }] })).toBe(false);
  });
});
