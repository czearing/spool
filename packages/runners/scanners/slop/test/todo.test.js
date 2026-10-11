import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTodoData } from "../todo.js";

test("buildTodoData generates valid structured output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "slop-todo-"));
  try {
    const treeDir = join(tempDir, "apps/new-office/src");
    mkdirSync(treeDir, { recursive: true });

    writeFileSync(
      join(treeDir, "index.ts"),
      `
// ==================== IMPORTS ====================
// Sets the current index
export function setIndex(index: number) {
  // If index is valid
  if (index > 0) {
    return index;
  }
}
`,
      "utf8",
    );

    const data = buildTodoData({
      repoRoot: tempDir,
      trees: ["apps/new-office"],
      minScore: 60,
      maxRankedFiles: 10,
    });

    assert.ok(data.generatedAt);
    assert.equal(data.summary.totalFilesScanned, 1);
    assert.equal(data.summary.filesWithSlop, 1);
    assert.ok(data.summary.totalSlopComments >= 2);
    assert.ok(data.rankedFiles.length === 1);
    assert.equal(data.rankedFiles[0].path, "apps/new-office/src/index.ts");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
