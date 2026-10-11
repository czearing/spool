import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { creationContext, createWithOrigin } from "../../packages/bohemia-pr-mcp/src/pr-origin.mjs";
import { fixture } from "./fixtures.mjs";
import { readJson, writeJson } from "../spool-files.mjs";

function globalTask(t, fields) {
  const f = fixture(t);
  const context = { version: 1, originKind: "spool", taskId: `manual-${randomUUID()}`, agent: "perf",
    sessionId: randomUUID(), receiptDirectory: path.join(f.store.records, "native-creators"), ...fields };
  const contextFile = path.join(f.root, "context.json");
  writeJson(contextFile, context);
  const environment = { BOHEMIA_CREATOR_CONTEXT: contextFile, COPILOT_SESSION_ID: context.sessionId };
  f.put({ id: context.taskId, agent: context.agent, session_id: context.sessionId, workspace: null }, "failed");
  return { ...f, context, contextFile, environment };
}

for (const [name, fields] of [["null", { workspace: null, branch: null }], ["absent", {}]]) {
  test(`global creator with ${name} repository context publishes through the gated tool without task migration`, t => {
    const f = globalTask(t, fields);
    assert.deepEqual(creationContext(f.environment), f.context);
    assert.throws(() => creationContext({ ...f.environment, COPILOT_SESSION_ID: randomUUID() }), /context/);
    const taskFile = path.join(f.root, "queues", "failed", `${f.context.taskId}.json`);
    const originalTask = readJson(taskFile);
    const script = fileURLToPath(new URL("./fixtures/pr-publication.ts", import.meta.url));
    const result = spawnSync("bun", [script], { cwd: f.workspace, encoding: "utf8", windowsHide: true,
      timeout: 60_000, env: { ...process.env, ...f.environment, USERPROFILE: f.root, HOME: f.root } });
    assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
    const receipt = readJson(path.join(f.context.receiptDirectory, `${f.context.taskId}.json`));
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
    { branch: "" }, { branch: " " }, { branch: 42 }, { taskId: "../escape" },
    { sessionId: "unknown" }, { agent: "pr-updater" }, { agent: "pr-reviewer" }]) {
    writeJson(f.contextFile, { ...f.context, ...change });
    assert.throws(() => creationContext(f.environment), /context/);
  }
});

test("any supplied checkout or branch constraint remains enforced before publication", async t => {
  const f = globalTask(t, {});
  const input = { repository: "fixture", sourceBranch: "user/origin", targetBranch: "master" };
  const api = { create() { assert.fail("Mismatched context must never publish"); } };
  for (const fields of [{ workspace: f.root }, { branch: "user/other" }]) {
    writeJson(f.contextFile, { ...f.context, ...fields });
    await assert.rejects(createWithOrigin({ context: creationContext(f.environment),
      input, repoRoot: f.workspace, api }), /checkout\/branch does not match/);
  }
});
