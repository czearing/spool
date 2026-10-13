import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { publication, before } from "./spelling-publication-fixture.mjs";
import { assertSubstantiveChanges } from "../../packages/bohemia-pr-mcp/src/pr-content.mjs";
import { regenerateBatch } from "../../scanners/spelling/repair.mjs";
import { readJson } from "../spool-store.mjs";

const file = "packages/a/src/a.ts";
test("a correction already landed during preparation cannot generate metadata or open a PR", async t => {
  const f = publication(t);
  let metadata = 0;
  const publish = f.publisher({ execute: () => { metadata++; },
    call: async (name, args) => {
      if (name === "bohemia_prepare") {
        writeFileSync(path.join(f.workspace, file), before.replace("missspelled", "misspelled"));
        f.git(f.workspace, "add", "."); f.git(f.workspace, "commit", "-m", "fix already landed");
      }
      return f.options.call(name, args);
    } });
  await assert.rejects(publish(f.report), /No substantive changes remain/);
  assert.equal(f.posts(), 0);
  assert.equal(metadata, 0);
  assert.equal(f.store.tasks().length, 0);
  assert.deepEqual(f.calls.map(call => call.name), ["bohemia_prepare"]);
  assert.equal(f.git(f.publicationRoot, "status", "--porcelain"), "");
});
for (const kind of ["metadata", "line endings", "reverted changes"]) {
  test(`${kind} alone cannot create a PR, even when the target has unrelated changes`, t => {
    const f = publication(t), root = f.publicationRoot, base = f.report.commit;
    f.git(root, "config", "core.autocrlf", "false");
    f.git(root, "checkout", "-b", "candidate");
    mkdirSync(path.join(root, "change"));
    writeFileSync(path.join(root, "change", "fixture.json"), '{"type":"none"}');
    if (kind === "line endings") writeFileSync(path.join(root, file), before.replaceAll("\n", "\r\n"));
    if (kind === "reverted changes") {
      writeFileSync(path.join(root, file), before.replace("missspelled", "misspelled"));
      f.git(root, "add", "."); f.git(root, "commit", "-m", "old corrections");
      writeFileSync(path.join(root, file), before);
    }
    f.git(root, "add", "."); f.git(root, "commit", "-m", kind);
    const head = f.git(root, "rev-parse", "HEAD");
    f.git(root, "checkout", "-b", "advanced-target", base);
    writeFileSync(path.join(root, "unrelated.txt"), "Target-only change.");
    f.git(root, "add", "."); f.git(root, "commit", "-m", "unrelated target work");
    const target = f.git(root, "rev-parse", "HEAD");
    assert.throws(() => assertSubstantiveChanges(root, target, head), /No substantive changes remain/);
  });
}
test("genuine source changes remain publishable alongside metadata", async t => {
  const f = publication(t);
  assert.equal((await f.publisher()(f.report)).created, 1);
  assert.doesNotThrow(() => assertSubstantiveChanges(f.publicationRoot, f.report.commit,
    f.git(f.publicationRoot, "rev-parse", "HEAD")));
  assert.throws(() => assertSubstantiveChanges(f.publicationRoot, "missing", f.report.commit), /exact source and target/);
});
test("regeneration identifies a metadata-only result without discarding the existing PR or authored work", async t => {
  const f = publication(t), original = "// Compare A against B.\nexport const value = 1;\n";
  writeFileSync(path.join(f.workspace, file), original);
  f.git(f.workspace, "add", "."); f.git(f.workspace, "commit", "-m", "safe baseline");
  const commit = f.git(f.workspace, "rev-parse", "HEAD");
  f.git(f.publicationRoot, "fetch", "origin", "master");
  f.git(f.publicationRoot, "checkout", "-b", "unsafe-old-pr", commit);
  writeFileSync(path.join(f.publicationRoot, file), original.replace("A against", "AN against"));
  mkdirSync(path.join(f.publicationRoot, "change"));
  const metadata = path.join(f.publicationRoot, "change", "fixture.json");
  writeFileSync(metadata, '{"type":"none","dependentChangeType":"none"}');
  f.git(f.publicationRoot, "add", "."); f.git(f.publicationRoot, "commit", "-m", "old unsafe edit");
  const head = f.git(f.publicationRoot, "rev-parse", "HEAD");
  const journal = { version: 1, batches: { original: { phase: "published", ownerId: "original",
    branch: "unsafe-old-pr", commit, head, files: [file] } } };
  const result = await regenerateBatch({ repo: f.publicationRoot, journal, owner: "original", apply: true });
  assert.equal(result.hasChanges, false);
  assert.deepEqual(result.remainingFiles, []);
  assert.equal(result.files.length, 1);
  assert.equal(readFileSync(path.join(f.publicationRoot, file), "utf8").replace(/\r\n/g, "\n"), original);
  assert.deepEqual(readJson(metadata), { type: "none", dependentChangeType: "none" });
  assert.equal(f.git(f.publicationRoot, "rev-parse", "HEAD"), head);
  assert.equal(f.posts(), 0);
});
