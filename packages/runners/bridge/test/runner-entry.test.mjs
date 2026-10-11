import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureRunnerEntry } from "../runner-entry.mjs";

test("upgrades legacy generated entries with blank lines but preserves handwritten code", t => {
  const root = mkdtempSync(path.join(tmpdir(), "spool-runner-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "runners", "spelling"), file = path.join(directory, "run.mjs");
  mkdirSync(directory, { recursive: true });
  for (const newline of ["\n", "\r\n"]) {
    writeFileSync(file, ['import { run } from "../../bridge/run.mjs";', '', 'await run("spelling", import.meta.url);', ''].join(newline));
    ensureRunnerEntry(root, "spelling");
    assert.match(readFileSync(file, "utf8"), /await runCustom\("spelling", import\.meta\.url\);/);
    ensureRunnerEntry(root, "spelling");
  }
  const handwritten = 'console.log("preserve custom code");\n';
  writeFileSync(file, handwritten);
  assert.throws(() => ensureRunnerEntry(root, "spelling"), /not editor-managed/);
  assert.equal(readFileSync(file, "utf8"), handwritten);
});
