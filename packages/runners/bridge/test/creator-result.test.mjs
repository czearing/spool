import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import fs, { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { digest, writeJson } from "../spool-store.mjs";
import { creatorResultHistory } from "../creator-result.mjs";
import { readCreatorResult } from "../updater.mjs";
import { fixture } from "./fixtures.mjs";

test("a generic reserved task has no publication receipts or result history", t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(f.store.records), false);
  assert.deepEqual(creatorResultHistory(f.store)({ id: "reserved" }), []);
  assert.equal(fs.existsSync(f.store.records), false);
});

test("canonical result artifacts preserve Windows paths, newlines and quotes without nested JSON", t => {
  const f = fixture(t), key = "spool-creator:pr:123:result", task = { id: "original" };
  const file = path.join(f.store.records, "results", `${digest(key)}.json`);
  writeJson(path.join(f.store.records, `${digest(key)}.json`), {
    key, taskId: task.id, phase: "published", contract: { resultFile: file },
  });
  const result = { submissionId: key, findings: [{ verification: {
    command: String.raw`node "C:\Code\repo\test.js"`, actual: "line one\nline two \"quoted\"",
  } }] };
  writeJson(file, result);
  assert.deepEqual(readCreatorResult(f.store, task, key), result);
  const history = creatorResultHistory(f.store);
  assert.deepEqual(history(task), [key]);
  assert.deepEqual(history({ id: "other" }), []);
  assert.throws(() => readCreatorResult(f.store, { id: "other" }, key), /does not belong/);
  writeJson(file, { submissionId: "other" });
  assert.throws(() => readCreatorResult(f.store, task, key), /another submission/);
});

test("history reads receipts once per operation, lazily, without hiding new submissions from the next operation", t => {
  const f = fixture(t), task = { id: "original" };
  const publish = (key, taskId, at, phase = "published") => writeJson(
    path.join(f.store.records, `${digest(key)}.json`), { key, taskId, phase, contract: { at } });
  publish("older", task.id, "2026-11-01");
  publish("newer", task.id, "2026-11-02");
  publish("other", "other", "2026-11-02");
  publish("pending", task.id, "2026-11-03", "pending");
  writeFileSync(path.join(f.store.records, "not-a-receipt.json"), "{");
  const readFile = fs.readFileSync, reads = [];
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (path.dirname(String(file)) === f.store.records) reads.push(path.basename(String(file)));
    return readFile(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const history = creatorResultHistory(f.store);
  assert.deepEqual(reads, []);
  assert.deepEqual(history(task), ["newer", "older"]);
  assert.deepEqual(history({ id: "other" }), ["other"]);
  assert.deepEqual(history(task), ["newer", "older"]);
  assert.deepEqual(reads.sort(), ["older", "newer", "other", "pending"].map(key => `${digest(key)}.json`).sort());
  publish("latest", task.id, "2026-11-03");
  assert.deepEqual(history(task), ["newer", "older"]);
  assert.deepEqual(creatorResultHistory(f.store)(task), ["latest", "newer", "older"]);
});

test("a discovery snapshot cannot authorize a result after its receipt changes owners", t => {
  const f = fixture(t), task = { id: "original" }, key = "result";
  const receiptFile = path.join(f.store.records, `${digest(key)}.json`);
  const receipt = { key, taskId: task.id, phase: "published", contract: {} };
  writeJson(receiptFile, receipt);
  writeJson(path.join(f.store.records, "results", `${digest(key)}.json`), { submissionId: key });
  const history = creatorResultHistory(f.store);
  assert.deepEqual(history(task), [key]);
  writeJson(receiptFile, { ...receipt, taskId: "another-task" });
  assert.deepEqual(history(task), [key]);
  assert.throws(() => readCreatorResult(f.store, task, key), /does not belong/);
  assert.deepEqual(creatorResultHistory(f.store)(task), []);
});

test("unknown, missing and redirected result artifacts fail explicitly", t => {
  const f = fixture(t), key = "unknown", task = { id: "original" };
  assert.throws(() => readCreatorResult(f.store, task, key), /does not belong/);
  const receipt = { taskId: task.id, phase: "published", contract: {} };
  writeJson(path.join(f.store.records, `${digest(key)}.json`), receipt);
  assert.throws(() => readCreatorResult(f.store, task, key), /missing/);
  writeJson(path.join(f.store.records, `${digest(key)}.json`), { ...receipt, contract: { resultFile: path.join(f.root, "unrelated.json") } });
  assert.throws(() => readCreatorResult(f.store, task, key), /outside/);
  writeJson(path.join(f.store.records, `${digest(key)}.json`), receipt);
  const file = path.join(f.store.records, "results", `${digest(key)}.json`);
  writeJson(file, {});
  writeFileSync(file, "{");
  assert.throws(() => readCreatorResult(f.store, task, key), /Cannot read/);
});
