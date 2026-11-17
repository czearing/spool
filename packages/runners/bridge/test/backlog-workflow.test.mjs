import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { backlogFixture, reviewers } from "./backlog-fixture.mjs";
import { createBacklogScan, backlogPrompt } from "../backlog.mjs";
import { eventRecipe, validateWorkflow, operationAvailable } from "@spool/workflow";
import { eventConfiguration } from "../workflow-event-config.mjs";
import { configure } from "../config.mjs";
import { inspectWorkflow } from "../workflow-inspection.mjs";
import { createEventPipeline, bindEventQueue } from "../workflow-event-pipeline.mjs";
import { repositoryCall } from "../repository-call.mjs";

test("catalog, configuration, preview, and native workflow agree on a direct minimal handoff", async t => {
  const f = backlogFixture(t), mcp = path.join(f.root, "repository.json");
  writeFileSync(mcp, "{}");
  const input = { spool_dir: f.root, repository_profile: "1js", repository_mcp_config: mcp,
    ado: { organization: "office", project: "Office", project_id: "project-id", repository: "1JS",
      creator_id: "creator-id", author_account: "owner@example.test" } };
  const workflow = { id: "library-backlog", kind: "custom", name: "Library backlog", enabled: true,
    workspace: f.workspace, intervalSeconds: 60,
    ...eventRecipe("backlog", { agent: f.config.agentId, parentWorkItem: 12284752, workItemProject: "OC",
      reviewers: JSON.stringify(reviewers), maxOpenPrs: 3 }) };
  validateWorkflow(workflow);
  assert.equal(operationAvailable({ operation: "dispatch-event" }, "backlog"), true);
  const { config } = configure(eventConfiguration(input, workflow), "backlog", f.root);
  assert.equal(config.repositoryProfile, "1js");
  assert.equal(config.repositoryMcpConfig, undefined);
  assert.equal(operationAvailable({ operation: "prepare-event" }, "backlog"), false);
  assert.equal(config.workItemProject, "OC");
  assert.equal(config.ado.project, "Office");
  assert.equal(config.parentWorkItem, 12284752);
  assert.equal(config.adoWslDistribution, undefined);
  assert.deepEqual(config.reviewers, reviewers);
  const preview = await inspectWorkflow(input, workflow);
  assert.equal(preview.inspection[workflow.nodes.at(-1).id].prompt,
    backlogPrompt("https://office.visualstudio.com/OC/_workitems/edit/{{workItem.id}}", reviewers));
  const pipeline = createEventPipeline(workflow, { store: f.store, runtime: f.runtime,
    verifyPreparation: async () => assert.fail("No repository preparation for native backlog delivery") });
  bindEventQueue(f.queue, pipeline);
  const scan = createBacklogScan({ store: f.store, config, queue: f.queue, runtime: f.runtime, workspace: f.workspace,
    client: f.client });
  const result = await scan();
  assert.equal(f.store.task(result.taskId).prompt, backlogPrompt(f.client.itemUrl(1), reviewers));
  assert.equal(f.store.metadata(result.taskId).preparation, undefined);
  const altered = structuredClone(workflow); altered.nodes.at(-1).prompt += "\nExtra instructions.";
  assert.throws(() => validateWorkflow(altered), /minimal/);
  altered.nodes.at(-1).prompt = "{{event.prompt}}"; altered.nodes.at(-1).agent = "perf";
  assert.doesNotThrow(() => validateWorkflow(altered));
});
test("backlog repository preparation goes through the existing 1JS MCP without a Bohemia invocation", async () => {
  let calls = 0;
  const config = { repositoryProfile: "1js", repositoryMcpConfig: "fixture" };
  const prepare = repositoryCall(config, { bohemia: async () => assert.fail("No Bohemia call"),
    repository: async (operation, repo, args, options) => {
      calls++; assert.equal(operation, "prepare"); assert.equal(repo, "1js");
      assert.equal(args.baseBranch, "main");
      assert.equal(options.env.REPOSITORY_MCP_CONFIG, "fixture");
      return { structuredContent: { ready: true } };
    } });
  await prepare("bohemia_prepare", { operation: "branch", baseBranch: "main" });
  assert.equal(calls, 1);
});
test("a cap-held event retries without creating, reading or preparing a branch", async t => {
  const f = backlogFixture(t);
  const workflow = { id: "library-backlog", kind: "custom", name: "Library backlog", enabled: true,
    workspace: f.workspace, intervalSeconds: 60,
    ...eventRecipe("backlog", { agent: f.config.agentId, parentWorkItem: 12284752, workItemProject: "OC",
      reviewers: JSON.stringify(reviewers), maxOpenPrs: 3 }) };
  let reads = 0;
  const pipeline = createEventPipeline(workflow, { store: f.store, runtime: f.runtime,
    verifyPreparation: async () => assert.fail("Native delivery cannot inspect a checkout") });
  bindEventQueue(f.queue, pipeline);
  f.client.listPullRequests = async () => ++reads === 2 ? [1, 2, 3].map(id =>
    ({ id: String(id), status: "active", branch: `user/calebzearing/library-backlog-${id}` })) : [];
  const scan = createBacklogScan({ store: f.store, config: f.config, queue: f.queue, workspace: f.workspace,
    runtime: f.runtime, client: f.client });
  assert.match((await scan()).holding, /3\/3/);
  pipeline.completeScan();
  assert.equal(f.store.tasks().length, 0);
  assert.equal((await scan()).dispatched, 1);
  assert.equal(f.calls.prepare.length, 0);
});
