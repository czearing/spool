import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  METRICS,
  metricByName,
  buildIdentifierIndex,
  loadTargets,
  measureFile,
  pathTokens,
  parseSections,
  sentencesOf,
  statedCommands,
  commentDrift,
} from "../metrics.js";
import { scanTrees } from "../scan.js";
import { commandsFixture, fixtureRepo, sourceOnlyFixture, trees } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

const scan = scanTrees({ repoRoot: fixtureRepo, trees });
const identifierIndex = buildIdentifierIndex({ repoRoot: fixtureRepo, sourcePaths: scan.source });

function numbers(relPath, kind) {
  return measureFile({ repoRoot: fixtureRepo, relPath, kind, identifierIndex });
}

test("navigation cost counts the paths a document names that do not exist", () => {
  const result = numbers("apps/new-office/docs/guide.md", "markdown")["docs.navigation-cost"];
  assert.equal(result.value, 1);
  assert.deepEqual(result.evidence, ["apps/new-office/src/gone.ts"]);
});

test("navigation cost resolves a path the way the tree that holds the document names it", () => {
  const result = numbers("apps/new-office/docs/guide.md", "markdown")["docs.navigation-cost"];
  assert.equal(result.value, 1, "src/router.ts resolves from the tree above the document");
  assert.deepEqual(result.evidence, ["apps/new-office/src/gone.ts"]);
});

test("navigation cost ignores urls, package specifiers and globs", () => {
  assert.deepEqual(pathTokens("see https://example.com/a/b and @scope/package and src/**/*.ts"), []);
  assert.deepEqual(pathTokens("the file apps/new-office/src/router.ts holds it"), ["apps/new-office/src/router.ts"]);
});

test("missing detail counts sections that instruct without a command, a path or a value", () => {
  const result = numbers("apps/new-office/docs/guide.md", "markdown")["docs.missing-detail"];
  assert.equal(result.value, 1);
  assert.deepEqual(result.evidence, ["Deploy the app"]);
});

test("restatement counts sections that reproduce names a reader can open directly", () => {
  const result = numbers("packages/new-office-ux/docs/component.md", "markdown")["docs.restatement"];
  assert.equal(result.value, 1);
  assert.equal(result.evidence[0].heading, "What the panel exports");
  assert.equal(result.evidence[0].hits, 7);
});

test("the identifier index is the exported names of the source tree", () => {
  assert.ok(identifierIndex.has("createPanel"));
  assert.ok(identifierIndex.has("mountRouter"));
  assert.equal(identifierIndex.has("panelId"), false, "a parameter is not an exported name");
});

test("padding counts sentences carrying no path, command, number or rule", () => {
  const result = numbers("apps/new-office/docs/guide.md", "markdown")["docs.padding"];
  assert.equal(result.value, 2);
  assert.equal(
    result.evidence[1],
    "This section is a general overview of the wider situation and the surrounding context.",
  );
});

test("comment drift counts exported symbols the signature no longer matches", () => {
  const result = numbers("packages/new-office-ux/src/panel.ts", "source")["docs.comment-drift"];
  assert.equal(result.value, 2);
  assert.deepEqual(
    result.evidence.map((entry) => entry.symbol),
    ["openPanel", "closePanel"],
  );
  assert.match(result.evidence[0].reasons[0], /legacyFlag/);
  assert.match(result.evidence[1].reasons[0], /returns nothing/);
});

test("a source file whose comments match its signatures scores zero", () => {
  assert.equal(numbers("apps/new-office/src/router.ts", "source")["docs.comment-drift"].value, 0);
});

function commandNumbers(relPath, kind) {
  return measureFile({ repoRoot: commandsFixture, relPath, kind, identifierIndex: new Set() });
}

test("command validity counts the stated commands that do not resolve against the repository", () => {
  const result = commandNumbers("docs/run.md", "markdown")["docs.command-validity"];
  assert.equal(result.value, 2, "npm run build and node tools/build.js both resolve");
  assert.deepEqual(
    result.evidence.map((entry) => entry.command),
    ["npm run publish-site", "node tools/missing.js"],
  );
  assert.match(result.evidence[0].reason, /no script named publish-site/);
  assert.match(result.evidence[1].reason, /no file at tools\/missing.js/);
});

test("a command stated in a source comment is counted the same as one stated in a document", () => {
  const result = commandNumbers("src/task.ts", "source")["docs.command-validity"];
  assert.equal(result.value, 1);
  assert.equal(result.evidence[0].command, "npm run lint");
});

test("both places a command can be stated are read, and nothing else is guessed at", () => {
  const stated = statedCommands({ text: "run `npm run build` and then some prose about npm run nothing", kind: "markdown" });
  assert.deepEqual(
    stated.map((command) => command.name),
    ["build"],
    "prose outside a code span is not a stated command",
  );
  const fromSource = statedCommands({ text: "// see `npm test` for the suite\nconst url = \"https://x/y\";\n", kind: "source" });
  assert.deepEqual(
    fromSource.map((command) => command.name),
    ["test"],
  );
});

test("command validity has a budget and a direction like every other metric", () => {
  const profile = loadTargets(resolve(here, "..", "targets.json"));
  assert.equal(profile.budgets["docs.command-validity"], 0);
  assert.equal(metricByName("docs.command-validity").direction, "lower_is_better");
  assert.equal(metricByName("docs.command-validity").kind, "both");
});

test("comment drift counts an interface member the doc comment names that the declaration lost", () => {
  const result = measureFile({
    repoRoot: sourceOnlyFixture,
    relPath: "packages/api/src/client.ts",
    kind: "source",
    identifierIndex: new Set(),
  })["docs.comment-drift"];
  const named = result.evidence.find((entry) => entry.symbol === "ClientOptions.retries");
  assert.ok(named, "the interface member the declaration does not have is counted");
  assert.match(named.reasons[0], /documents member retries the declaration does not have/);
});

test("comment drift counts an interface member left undocumented beside documented ones", () => {
  const result = measureFile({
    repoRoot: sourceOnlyFixture,
    relPath: "packages/api/src/client.ts",
    kind: "source",
    identifierIndex: new Set(),
  })["docs.comment-drift"];
  assert.equal(result.value, 4, "one function drift, one lost member, two undocumented members");
  assert.deepEqual(
    result.evidence.map((entry) => entry.symbol),
    ["send", "ClientOptions.retries", "ClientOptions.timeoutMs", "ClientOptions.headers"],
  );
  assert.match(result.evidence[3].reasons[0], /carries no doc comment beside members that have one/);
});

test("an interface with no documented member at all is not counted as drift", () => {
  const text = "export interface Plain {\n  one: string;\n  two: string;\n}\n";
  assert.equal(commentDrift({ text }).value, 0);
});

test("sections and sentences are split the same way every run", () => {
  const sections = parseSections("# One\n\ntext\n\n## Two\n\n```\n# not a heading\n```\n");
  assert.deepEqual(
    sections.map((section) => section.heading),
    ["One", "Two"],
  );
  assert.deepEqual(sentencesOf("One thing. Two things.\n\nThree."), ["One thing.", "Two things.", "Three."]);
});

test("every metric in the set has a budget in the shipped profile", () => {
  const profile = loadTargets(resolve(here, "..", "targets.json"));
  for (const metric of METRICS) {
    assert.equal(typeof profile.budgets[metric.name], "number", metric.name);
    assert.equal(metricByName(metric.name).direction, "lower_is_better");
  }
  assert.throws(() => metricByName("docs.not-a-metric"), /unknown metric/);
});
