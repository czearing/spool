import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { creationContext, createWithOrigin } from "../../packages/bohemia-pr-mcp/src/pr-origin.mjs";
import { fixture } from "./fixtures.mjs";
import { readJson, writeJson } from "../spool-files.mjs";
import { publicationFile } from "../../packages/bohemia-agent-tooling/src/publications.js";

function globalTask(t, fields) {
  const f = fixture(t);
  const context = { version: 1, originKind: "spool", taskId: `manual-${randomUUID()}`, agent: "perf",
    sessionId: randomUUID(), projectRoot: f.root, receiptDirectory: f.store.publicationDirectory, ...fields };
  const contextFile = path.join(f.root, "controls", "executions", `${context.taskId}.json`);
  writeJson(contextFile, context);
  const environment = { SPOOL_EXECUTION_CONTEXT: contextFile, COPILOT_SESSION_ID: context.sessionId,
    REPOSITORY_MCP_PUBLICATIONS: f.store.publicationDirectory };
  f.put({ id: context.taskId, agent: context.agent, session_id: context.sessionId, workspace: null }, "in_progress");
  return { ...f, context, contextFile, environment };
}

for (const [name, fields] of [["null", { workspace: null, branch: null }], ["absent", {}]]) {
  test(`global creator with ${name} repository context publishes through the gated tool without task migration`, t => {
    const f = globalTask(t, fields);
    assert.equal(creationContext(f.environment).sessionId, f.context.sessionId);
    assert.equal(creationContext(f.environment).workspace, null);
    assert.throws(() => creationContext({ ...f.environment, COPILOT_SESSION_ID: randomUUID() }), /context/);
    const taskFile = path.join(f.root, "queues", "in_progress", `${f.context.taskId}.json`);
    const originalTask = readJson(taskFile);
    const script = fileURLToPath(new URL("./fixtures/pr-publication.ts", import.meta.url));
    const result = spawnSync("bun", [script], { cwd: f.workspace, encoding: "utf8", windowsHide: true,
      timeout: 60_000, env: { ...process.env, ...f.environment, USERPROFILE: f.root, HOME: f.root } });
    assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
    const receipt = readJson(publicationFile("https://example.invalid/OC/_git/fixture/pullrequest/123", f.context.receiptDirectory));
    assert.equal(receipt.taskId, f.context.taskId);
    assert.equal(receipt.sessionId, f.context.sessionId);
    assert.equal(receipt.workspace, f.workspace);
    assert.equal(receipt.branch, "user/origin");
    assert.equal(receipt.verified, true);
    assert.deepEqual(readJson(taskFile), originalTask);
    assert.deepEqual(readJson(f.contextFile), f.context);
  });
}

test("optional repository context still rejects malformed supplied values and invalid creator identities", t => {
  const f = globalTask(t, { workspace: null, branch: null });
  for (const change of [{ workspace: "" }, { workspace: "relative" }, { workspace: 42 },
    { taskId: "../escape" },
    { sessionId: "unknown" }, { agent: "pr-updater" }, { agent: "pr-reviewer" }]) {
    writeJson(f.contextFile, { ...f.context, ...change });
    assert.throws(() => creationContext(f.environment), /context/);
  }
});

test("execution descriptors validate the workspace but do not constrain a task to one branch", t => {
  const f = globalTask(t, {});
  writeJson(f.contextFile, { ...f.context, workspace: f.root });
  assert.throws(() => creationContext(f.environment), /context/);
  writeJson(f.contextFile, { ...f.context, branch: "user/unrelated-old-preparation" });
  assert.equal(creationContext(f.environment).branch, undefined);
});
