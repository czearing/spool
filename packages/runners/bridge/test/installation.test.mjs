import assert from "node:assert/strict";
import test from "node:test";
import { engine, engineRoot } from "../sources.mjs";
import { realpathSync } from "node:fs";
import path from "node:path";

test("every real scanner entry point is bundled rather than resolved from a sibling checkout", async () => {
  const root = path.resolve(import.meta.dirname, "..", "..");
  assert.equal(realpathSync(engineRoot), realpathSync(path.join(root, "scanners")));
  for (const [file, exported] of [
    ["pr-reviewer/run.mjs", "runReviewer"],
    ["livesite/run.mjs", "runLivesite"],
    ["pr-updater/lib/pipeline.mjs", "pass"],
    ["perf/scanner.mjs", "runScanner"],
    ["docs/config.js", "buildCycleConfig"],
    ["slop/config.js", "buildSlopConfig"],
  ]) assert.equal(typeof (await engine(file))[exported], "function", file);
});
