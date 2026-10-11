import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as docs from "../docs/scan.js";
import * as slop from "../slop/scan.js";
import { exclusionReason as docsReason } from "../docs/exclusion.js";
import { exclusionReason as slopReason } from "../slop/exclusion.js";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "scanner-policies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ["src/main.ts", "src/guide.md", "src/main.d.ts", "src/main.test.ts",
    "src/__tests__/test.ts", "src/node_modules/dependency.ts", "src/dist/output.ts",
    "src/lib/library.ts", "src/temp/draft.ts", "src/AGENTS.md", "src/prompt/code.ts",
    "src/strings.ts", "src/generated/data.ts", "src/component.generated.tsx",
    "src/newOfficeStrings.ts", "src/fixtures/sample.ts", "src/.github/skills/rule.md"]) {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, "fixture\n");
  }
  return root;
}

test("docs and slop share traversal without sharing their different collection policies", t => {
  const repoRoot = fixture(t), options = { repoRoot, trees: ["src", "optional-missing-tree"] };
  const documentation = docs.scanTrees(options), comments = slop.scanTrees(options);
  assert.deepEqual(documentation.markdown, ["src/guide.md"]);
  assert.deepEqual(documentation.source, [
    "src/component.generated.tsx", "src/fixtures/sample.ts", "src/generated/data.ts",
    "src/lib/library.ts", "src/main.ts", "src/newOfficeStrings.ts", "src/strings.ts", "src/temp/draft.ts",
  ]);
  assert.deepEqual(comments.source, ["src/main.ts"]);
  assert.equal(Object.hasOwn(comments, "markdown"), false, "Preserve slop's output shape");
  assert.ok(documentation.skipped.some(item => item.path === "src/AGENTS.md"));
  assert.ok(comments.skipped.some(item => item.path === "src/generated/data.ts"));
  for (const result of [documentation, comments]) {
    assert.ok(result.skipped.some(item => item.path === "src/prompt/code.ts"));
    assert.ok(!result.source.some(file => /node_modules|dist|__tests__|\.test\.|\.d\.ts$/.test(file)));
  }
});

test("shared exclusions preserve reason precedence and platform-independent agent protection", () => {
  for (const reason of [docsReason, slopReason]) {
    assert.equal(reason(""), "empty path");
    assert.equal(reason("src\\AGENTS.md"), "excluded filename agents.md");
    assert.equal(reason(".github\\SKILLS\\anything.ts"), "excluded directory .github/skills");
    assert.equal(reason("src\\CopilotPanel.ts"), "excluded path segment contains copilot");
  }
  assert.equal(docsReason("src/newOfficeStrings.ts"), null);
  assert.equal(slopReason("src/newOfficeStrings.ts"), "excluded filename newofficestrings.ts");
  assert.equal(slopReason("src/agent/component.generated.tsx"), "excluded generated file suffix .generated.tsx");
});

test("inScope retains each scanner's kinds and exclusions without matching neighboring trees", () => {
  const paths = ["src/guide.md", "src/main.ts", "src/generated.ts", "src/main.test.ts", "src-other/main.ts"];
  assert.deepEqual(docs.inScope({ paths, trees: ["src"] }).kept, paths.slice(0, 3));
  assert.deepEqual(slop.inScope({ paths, trees: ["src"] }).kept, ["src/main.ts"]);
});

for (const operation of ["statSync", "readdirSync"]) {
  test(`${operation} failures are explicit rather than successful empty scans`, t => {
    const repoRoot = fixture(t);
    t.mock.method(fs, operation, () => { throw Object.assign(new Error("Access denied"), { code: "EACCES" }); });
    syncBuiltinESMExports();
    try {
      for (const scanner of [docs, slop]) {
        assert.throws(() => scanner.scanTrees({ repoRoot, trees: ["src"] }), { code: "EACCES" });
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}
