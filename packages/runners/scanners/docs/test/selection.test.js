import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocumentSets, renderDocsTask, readerFor, directoryOf } from "../docset.js";
import { loadTargets, buildIdentifierIndex } from "../metrics.js";
import { scanTrees } from "../scan.js";
import { defineDocsSelector } from "../select.js";
import { EXCLUSION_STATEMENT } from "../exclusion.js";
import { fixtureRepo, readers, trees, sourceOnlyFixture, apiReaders, apiTrees } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const budgets = loadTargets(resolve(here, "..", "targets.json")).budgets;

test("a document set never spans two readers even when the files share a directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-readers-"));
  try {
    mkdirSync(join(dir, "shared"), { recursive: true });
    const padding = [
      "The team believes the shape of the thing is broadly aligned with the direction of travel.",
      "A reader who wants the philosophy will find the underlying reasoning quite compelling here.",
      "This section is a general overview of the wider situation and the surrounding context of it.",
      "There is a broadly shared sense that the approach taken remains the correct approach today.",
      "Everyone involved would agree that the wider picture matters more than the narrow detail.",
      "The general direction of the work has been settled for some considerable time already.",
      "It follows that the reader will already know what the rest of the section is about.",
    ].join("\n\n");
    writeFileSync(join(dir, "shared", "a-one.md"), `# A\n\n${padding}\n`, "utf8");
    writeFileSync(join(dir, "shared", "b-one.md"), `# B\n\n${padding}\n`, "utf8");

    const twoReaders = [
      { id: "reader-a", match: "^shared/a-", reader: "reader a", job: "job a" },
      { id: "reader-b", match: "^shared/b-", reader: "reader b", job: "job b" },
    ];

    const built = buildDocumentSets({
      repoRoot: dir,
      files: [
        { path: "shared/a-one.md", kind: "markdown" },
        { path: "shared/b-one.md", kind: "markdown" },
      ],
      budgets,
      readers: twoReaders,
      identifierIndex: new Set(),
      maxFilesPerSet: 4,
    });

    assert.equal(built.observations.length, 2, "one set per reader, never one set across both");
    for (const observation of built.observations) {
      const owners = new Set(observation.files.map((file) => readerFor(file.path, twoReaders).id));
      assert.equal(owners.size, 1);
      assert.ok(owners.has(observation.readerId));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file with no reader is never grouped into somebody else's set", () => {
  const built = buildDocumentSets({
    repoRoot: fixtureRepo,
    files: [{ path: "elsewhere/notes.md", kind: "markdown" }],
    budgets,
    readers,
    identifierIndex: new Set(),
  });
  assert.equal(built.observations.length, 0);
  assert.equal(built.measured.length, 0);
});

test("a set is keyed by its reader and one place in the tree", () => {
  assert.equal(directoryOf("apps/new-office/docs/guide.md"), "apps/new-office");
  const scan = scanTrees({ repoRoot: fixtureRepo, trees });
  const identifierIndex = buildIdentifierIndex({ repoRoot: fixtureRepo, sourcePaths: scan.source });
  const built = buildDocumentSets({
    repoRoot: fixtureRepo,
    files: [
      ...scan.markdown.map((path) => ({ path, kind: "markdown" })),
      ...scan.source.map((path) => ({ path, kind: "source" })),
    ],
    budgets,
    readers,
    identifierIndex,
  });

  const keys = built.observations.map((observation) => observation.metric);
  assert.deepEqual(keys.sort(), [
    "docs.set:new-office-app:apps/new-office",
    "docs.set:new-office-ux:packages/new-office-ux",
  ]);
  for (const observation of built.observations) {
    for (const file of observation.files) {
      assert.ok(file.path.startsWith(`${observation.directory}/`));
    }
  }
});

test("the worst set is the one selected and the issue carries only what it is allowed to say", () => {
  const scan = scanTrees({ repoRoot: fixtureRepo, trees });
  const identifierIndex = buildIdentifierIndex({ repoRoot: fixtureRepo, sourcePaths: scan.source });
  const built = buildDocumentSets({
    repoRoot: fixtureRepo,
    files: [
      ...scan.markdown.map((path) => ({ path, kind: "markdown" })),
      ...scan.source.map((path) => ({ path, kind: "source" })),
    ],
    budgets,
    readers,
    identifierIndex,
  });

  const selection = defineDocsSelector({ minOverage: 1 })(built.observations);
  assert.equal(selection.candidate.setKey, "new-office-ux:packages/new-office-ux");
  assert.equal(selection.candidate.current, 2);

  const issue = renderDocsTask(selection.candidate, { exclusionStatement: EXCLUSION_STATEMENT });
  assert.match(issue.title, /^docs: packages\/new-office-ux overage 2$/);
  assert.match(issue.body, /document set: packages\/new-office-ux\/src\/panel.ts/);
  assert.match(issue.body, /reader: an engineer consuming a new office ux component/);
  assert.match(issue.body, /job: call the component/);
  assert.match(issue.body, /set holds together: one reader and one place in the tree/);
  assert.match(issue.body, /comment-drift 2\/0/);
  const reproduction = /reproduction: node "([^"]+)" packages\/new-office-ux\/src\/panel.ts/.exec(issue.body);
  assert.ok(reproduction, "the issue carries a reproduction command with a quoted entry point");
  assert.equal(existsSync(reproduction[1]), true, "the command written into the issue names a file that exists");
  assert.match(issue.body, /acceptance: every number at or below its budget, total overage 0 from 2/);
  assert.match(issue.body, /exclusion: never touch AGENTS.md/);
  assert.equal(/CLAUDE.md or SKILL.md at any depth/.test(issue.body), true, "the exclusion is restated for the writer");
});

test("renderDocsTask includes branch and clean workspace notice when branch is provided", () => {
  const candidate = {
    files: [{ path: "packages/new-office-ux/src/panel.ts", metrics: [{ metric: "docs.comment-drift", current: 2, budget: 0, over: 2 }] }],
    reader: "an engineer",
    job: "call component",
    thesis: "one reader",
    reproduction: "node measure.js",
    acceptance: 0,
    current: 2,
    directory: "packages/new-office-ux/src",
    branchName: "user/calebzearing/docs-packages-new-office-ux",
    repoRoot: "C:\\Code\\bohemia\\office-bohemia-tech-writter",
  };

  const issue = renderDocsTask(candidate, { exclusionStatement: EXCLUSION_STATEMENT });
  assert.match(issue.body, /The branch `user\/calebzearing\/docs-packages-new-office-ux` is checked out in `C:\\Code\\bohemia\\office-bohemia-tech-writter` and verified clean\./);
  assert.match(issue.body, /Do not run git checkout, fetch, reset, or clean; proceed directly to your edits\./);
  assert.equal(issue.body.includes("copilot-notes"), false);
});

test("a set with no markdown in it is selectable when its source comments cost the reader most", () => {
  const scan = scanTrees({ repoRoot: sourceOnlyFixture, trees: apiTrees });
  const identifierIndex = buildIdentifierIndex({ repoRoot: sourceOnlyFixture, sourcePaths: scan.source });
  const built = buildDocumentSets({
    repoRoot: sourceOnlyFixture,
    files: [
      ...scan.markdown.map((path) => ({ path, kind: "markdown" })),
      ...scan.source.map((path) => ({ path, kind: "source" })),
    ],
    budgets,
    readers: apiReaders,
    identifierIndex,
  });

  const markdownSets = built.observations.filter((observation) =>
    observation.files.some((file) => file.kind === "markdown"),
  );
  assert.ok(markdownSets.length > 0, "there is a markdown candidate for the source set to outscore");

  const selection = defineDocsSelector({ minOverage: 1 })(built.observations);
  assert.equal(selection.candidate.setKey, "api-consumer:packages/api");
  assert.equal(selection.candidate.current, 4);
  assert.deepEqual(
    [...new Set(selection.candidate.files.map((file) => file.kind))],
    ["source"],
    "the selected set contains no markdown at all",
  );

  const issue = renderDocsTask(selection.candidate, { exclusionStatement: EXCLUSION_STATEMENT });
  assert.match(issue.body, /document set: packages\/api\/src\/client.ts/);
  const reproduction = /reproduction: node "([^"]+)" packages\/api\/src\/client.ts/.exec(issue.body);
  assert.ok(reproduction, "the issue carries a reproduction command with a quoted entry point");
  assert.equal(existsSync(reproduction[1]), true, "the command written into the issue names a file that exists");
  assert.match(issue.body, /comment-drift 4\/0/);
});
