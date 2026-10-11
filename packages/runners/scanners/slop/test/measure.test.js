import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measurePaths } from "../measure.js";

test("measurePaths aggregates metrics and total overages across multiple files", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "slop-measure-"));
  try {
    mkdirSync(join(tempDir, "src"), { recursive: true });

    const file1 = "src/a.ts";
    const file2 = "src/b.ts";

    writeFileSync(
      join(tempDir, file1),
      `
// Set the name
export function setName(name: string) {}
`,
      "utf8",
    );

    writeFileSync(
      join(tempDir, file2),
      `
// ==================== HANDLERS ====================
export function handleClick() {}
`,
      "utf8",
    );

    const result = measurePaths({
      repoRoot: tempDir,
      paths: [file1, file2],
      budgets: {
        "slop.tautology-comments": 0,
        "slop.structural-noise": 0,
        "slop.ai-filler-comments": 0,
        "slop.bloated-doc-blocks": 0,
        "slop.micro-narration": 0,
        "slop.total-slop-lines": 0,
      },
      minScore: 60,
    });

    assert.equal(result.rows.length, 2);
    assert.ok(result.totalSlopComments >= 2);
    assert.ok(result.totalSlopLines >= 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
