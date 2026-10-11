import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureFile, METRICS } from "../metrics.js";

test("measureFile returns metric counts and slop lines for file with AI comments", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "slop-test-"));
  try {
    const filePath = "src/example.ts";
    const absolute = join(tempDir, "src");
    mkdirSync(absolute, { recursive: true });

    const content = `
// ==================== STATE ====================
// The current counter value
let counter = 0;

// Helper function to increment counter and ensure valid bounds
export function incrementCounter() {
  // If counter is valid
  if (counter >= 0) {
    counter += 1;
  }
}
`;
    writeFileSync(join(tempDir, filePath), content, "utf8");

    const result = measureFile({ repoRoot: tempDir, relPath: filePath, minScore: 60 });
    assert.ok(result);
    assert.ok(result.totalSlopComments >= 3);
    assert.ok(result["slop.structural-noise"].value >= 1);
    assert.ok(result["slop.tautology-comments"].value >= 1 || result["slop.ai-filler-comments"].value >= 1);
    assert.ok(result["slop.micro-narration"].value >= 1);
    assert.ok(result.totalSlopLines >= 3);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("measureFile returns zero slop for clean code", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "slop-clean-"));
  try {
    const filePath = "src/clean.ts";
    mkdirSync(join(tempDir, "src"), { recursive: true });

    const content = `
// React Compiler requires immutable ref here to prevent hydration mismatch
export function useCleanHook(initialState: number) {
  return initialState * 2;
}
`;
    writeFileSync(join(tempDir, filePath), content, "utf8");

    const result = measureFile({ repoRoot: tempDir, relPath: filePath, minScore: 60 });
    assert.ok(result);
    assert.equal(result.totalSlopComments, 0);
    assert.equal(result.totalSlopLines, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
