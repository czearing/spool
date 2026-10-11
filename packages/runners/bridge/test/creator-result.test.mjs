import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { digest, writeJson } from "../spool-store.mjs";
import { readCreatorResult } from "../updater.mjs";
import { fixture } from "./fixtures.mjs";

test("canonical result artifacts preserve Windows paths, newlines and quotes without nested JSON", t => {
  const f = fixture(t), key = "spool-creator:pr:123:result", task = { id: "original" };
  const file = path.join(f.store.records, "results", `${digest(key)}.json`);
  writeJson(path.join(f.store.records, `${digest(key)}.json`), {
    taskId: task.id, phase: "published", contract: { resultFile: file },
  });
  const result = { submissionId: key, findings: [{ verification: {
    command: String.raw`node "C:\Code\repo\test.js"`, actual: "line one\nline two \"quoted\"",
  } }] };
  writeJson(file, result);
  assert.deepEqual(readCreatorResult(f.store, task, `PR_UPDATE_RESULT_FILE: ${key}`), result);
  assert.deepEqual(readCreatorResult(f.store, task, `PR_UPDATE_RESULT: ${JSON.stringify(result)}`), result);
  assert.throws(() => readCreatorResult(f.store, { id: "other" }, `PR_UPDATE_RESULT_FILE: ${key}`), /does not belong/);
  writeJson(file, { submissionId: "other" });
  assert.throws(() => readCreatorResult(f.store, task, `PR_UPDATE_RESULT_FILE: ${key}`), /another submission/);
});

test("unknown, missing and redirected result artifacts fail explicitly", t => {
  const f = fixture(t), key = "unknown", task = { id: "original" };
  assert.throws(() => readCreatorResult(f.store, task, `PR_UPDATE_RESULT_FILE: ${key}`), /does not belong/);
  const receipt = { taskId: task.id, phase: "published", contract: {} };
  writeJson(path.join(f.store.records, `${digest(key)}.json`), receipt);
  assert.throws(() => readCreatorResult(f.store, task, `PR_UPDATE_RESULT_FILE: ${key}`), /missing/);
  writeJson(path.join(f.store.records, `${digest(key)}.json`), { ...receipt, contract: { resultFile: path.join(f.root, "unrelated.json") } });
  assert.throws(() => readCreatorResult(f.store, task, `PR_UPDATE_RESULT_FILE: ${key}`), /outside/);
  assert.throws(() => readCreatorResult(f.store, task, String.raw`PR_UPDATE_RESULT: {"path":"C:\Code"}`), /escaped/);
});
