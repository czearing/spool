import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { exclusionReason, isExcluded, partition } from "../exclusion.js";
import { scanTrees } from "../scan.js";
import { buildIdentifierIndex, loadTargets } from "../metrics.js";
import { buildDocumentSets } from "../docset.js";
import { readers, trees } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "fixtures", "repo");

test("agent related filenames are excluded at any depth", () => {
  assert.ok(isExcluded("AGENTS.md"));
  assert.ok(isExcluded("apps/new-office/docs/AGENTS.md"));
  assert.ok(isExcluded("packages/new-office-ux/CLAUDE.md"));
  assert.ok(isExcluded("apps/new-office/deep/nest/SKILL.md"));
  assert.ok(isExcluded("apps/new-office/docs/agents.md"), "the check is not case sensitive");
});

test("the four github directories are excluded", () => {
  for (const directory of ["skills", "prompts", "agents", "instructions"]) {
    assert.ok(isExcluded(`.github/${directory}/thing.md`), directory);
    assert.ok(isExcluded(`apps/new-office/.github/${directory}/thing.md`), directory);
  }
  assert.equal(isExcluded(".github/workflows/build.yml"), false);
});

test("a path segment naming agent, copilot or prompt is excluded", () => {
  assert.ok(isExcluded("apps/new-office/docs/copilot-notes/notes.md"));
  assert.ok(isExcluded("apps/new-office/agent-runner/readme.md"));
  assert.ok(isExcluded("packages/new-office-ux/src/prompt-builder.ts"));
  assert.equal(isExcluded("apps/new-office/src/router.ts"), false);
});

test("the reason is recorded rather than the path being dropped silently", () => {
  const result = partition(["apps/new-office/docs/guide.md", "apps/new-office/docs/AGENTS.md"]);
  assert.deepEqual(result.kept, ["apps/new-office/docs/guide.md"]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /excluded filename agents.md/);
  assert.equal(exclusionReason("apps/new-office/docs/guide.md"), null);
});

test("the scan never returns an excluded path and records every skip", () => {
  const scan = scanTrees({ repoRoot, trees });
  const all = [...scan.markdown, ...scan.source];
  assert.equal(all.some((path) => isExcluded(path)), false);
  assert.ok(scan.skipped.some((entry) => entry.path.endsWith("AGENTS.md")));
  assert.ok(scan.skipped.some((entry) => entry.path.includes("copilot-notes")));
});

test("a tree whose worst file by every metric is excluded still selects the worst file that is not", () => {
  const scan = scanTrees({ repoRoot, trees });
  const identifierIndex = buildIdentifierIndex({ repoRoot, sourcePaths: scan.source });
  const profile = loadTargets(resolve(here, "..", "targets.json"));
  const files = [
    ...scan.markdown.map((path) => ({ path, kind: "markdown" })),
    ...scan.source.map((path) => ({ path, kind: "source" })),
  ];

  const built = buildDocumentSets({
    repoRoot,
    files,
    budgets: profile.budgets,
    readers,
    identifierIndex,
    maxFilesPerSet: 4,
  });

  const named = built.observations.flatMap((observation) => observation.files.map((file) => file.path));
  assert.ok(named.length > 0, "something is still selectable once the excluded file is gone");
  assert.equal(named.some((path) => isExcluded(path)), false);
  assert.equal(built.measured.some((entry) => entry.path.endsWith("AGENTS.md")), false);
  assert.ok(named.includes("apps/new-office/docs/guide.md"));
  assert.ok(scan.skipped.length >= 2, "the skip is recorded");
});
