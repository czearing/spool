import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readRunnerJson, writeRunnerJson, writeRunnerJsonAsync } from "../src/runner-files.js";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "atomic-runner-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("sync and async writers produce the same JSON representation", async t => {
  const root = fixture(t), a = path.join(root, "sync.json"), b = path.join(root, "nested", "async.json");
  const value = { alerts: { build: "failed" }, active: ["task"] };
  writeRunnerJson(a, value);
  await writeRunnerJsonAsync(b, value);
  assert.equal(readFileSync(a, "utf8"), readFileSync(b, "utf8"));
  assert.deepEqual(readRunnerJson(b), value);
});

test("concurrent async writes use distinct temporary files and publish complete records", async t => {
  const root = fixture(t), file = path.join(root, "state.json");
  await Promise.all(Array.from({ length: 25 }, (_, index) =>
    writeRunnerJsonAsync(file, { index, content: String(index).repeat(4096) })));
  const result = readRunnerJson(file);
  assert.equal(result.content, String(result.index).repeat(4096));
  assert.deepEqual(readdirSync(root), ["state.json"]);
});

test("failed publication is explicit and cleans only its temporary file", async t => {
  const root = fixture(t), target = path.join(root, "directory");
  mkdirSync(target);
  await assert.rejects(writeRunnerJsonAsync(target, { value: 1 }));
  assert.deepEqual(readdirSync(root), ["directory"]);
});
