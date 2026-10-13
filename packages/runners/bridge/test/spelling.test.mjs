import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { proseText, checkRepository, writeReport, createProseChecker } from "../../scanners/spelling/check.mjs";
import { configure } from "../config.mjs";
import { createSpellingScan } from "../spelling.mjs";
import { runnerSnapshot } from "../runner-snapshot.mjs";
import { fixture } from "./fixtures.mjs";

test("Markdown inventory excludes code, links, HTML and frontmatter", () => {
  const text = "---\nname: missspelled\n---\n# A missspelled heading\n\n" +
    "`missspelled` [missspelled](https://example.test/missspelled)\n" +
    "```ts\nconst missspelled = 1;\n```\n    missspelled\n";
  const prose = proseText("docs/guide.md", text);
  assert.equal(prose.length, text.length);
  assert.equal(prose.match(/missspelled/g).length, 1);
  assert.equal(prose.indexOf("missspelled"), text.indexOf("missspelled heading"));
});

test("only actual JS/TS comments are scanned, not interfaces, strings or JSX text", () => {
  const text = "/** A missspelled comment */\nexport interface missspelled { value: string }\n" +
    "// Another missspelled comment\nexport const value = 'missspelled';\n" +
    "export const view = <div>/** missspelled */</div>;\n";
  const prose = proseText("src/example.tsx", text);
  assert.equal(prose.length, text.length);
  assert.equal(prose.match(/missspelled/g).length, 2);
  for (const file of ["AGENTS.md", ".github/a.md", "vendor/a.md", "src/a.d.ts", "src/a.generated.ts"]) {
    assert.equal(proseText(file, text), "");
  }
});

function gitFixture(t) {
  const f = fixture(t), repo = f.workspace;
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "master"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  const markdown = "A missspelled word in the documentation\nconstructor is a valid word\n";
  const source = "/** A missspelled comment */\nexport interface missspelled { value: string }\nexport const x = 'missspelled';\n";
  writeFileSync(path.join(repo, "README.md"), markdown); writeFileSync(path.join(repo, "a.ts"), source);
  git("add", "."); git("commit", "-m", "base");
  return { ...f, repo, git, markdown, source };
}

test("dictionary scan finds typos outside the old whitelist and leaves all repository bytes unchanged", async t => {
  const f = gitFixture(t);
  const result = await checkRepository(f.repo);
  assert.equal(result.filesScanned, 2);
  assert.equal(result.filesWithIssues, 2);
  assert.equal(result.issues, 2);
  assert.deepEqual(result.findings.map(item => item.issues[0].word), ["missspelled", "missspelled"]);
  assert.equal(result.findings.find(item => item.file === "README.md").issues[0].line, 1);
  assert.equal(readFileSync(path.join(f.repo, "README.md"), "utf8"), f.markdown);
  assert.equal(readFileSync(path.join(f.repo, "a.ts"), "utf8"), f.source);
  assert.equal(f.git("status", "--porcelain"), "");
  const reports = writeReport(path.join(f.root, "reports"), result);
  assert.match(readFileSync(reports.markdown, "utf8"), /- \[ \] \*\*README\.md\*\*/);
  assert.match(readFileSync(reports.html, "utf8"), /Spelling todo/);
  assert.equal(JSON.parse(readFileSync(reports.json)).findings.length, 2);
});

test("ranked dictionaries catch non-preferred typos while tied corrections and project terms remain held", async () => {
  const checker = await createProseChecker(["interoperablity"]);
  try {
    for (const [word, expected] of [["paradgmatic", "paradigmatic"], ["grammatcal", "grammatical"],
      ["parmeterized", "parameterized"], ["parametriclly", "parametrically"]]) {
      assert.equal(checker.dictionary.getPreferredSuggestions(word).length, 0, word);
      const checked = await checker.check("packages/a/src/a.ts", `// The ${word} result is ready.\n`);
      const spelling = checked.issues.filter(issue => issue.kind === "spelling");
      assert.deepEqual(spelling.map(issue => issue.suggestions), [[expected]], word);
    }
    for (const word of ["lexicographicaly", "catlog", "zzprojectname"]) {
      const checked = await checker.check("packages/a/src/a.ts", `// The ${word} result is ready.\n`);
      assert.ok(!checked.issues.some(issue => issue.kind === "spelling"), word);
      assert.ok(checked.review.some(issue => issue.word === word), word);
    }
    const checked = await checker.check("packages/a/src/a.ts",
      "// The interoperablity behaviour is ready.\nexport const grammatcal = 'paradgmatic';\n");
    assert.equal(checked.issues.length, 0);
    assert.equal(checked.review.length, 0);
  } finally { await checker.dispose(); }
});

test("ranked dictionary guesses hold unfamiliar capitalized terms while lowercase typos remain correctable", async () => {
  const checker = await createProseChecker();
  try {
    const checked = await checker.check("packages/a/README.md",
      "## Contacts\n\n* Manish Shukla - Product manager\n\n" +
      "Grammatcal descriptions need review.\n\nMissspelled words and grammatcal errors are detected.\n");
    assert.equal(checker.dictionary.getPreferredSuggestions("Shukla").length, 0);
    assert.equal(checker.dictionary.getPreferredSuggestions("Missspelled").length, 0);
    assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
      .map(issue => [issue.word, issue.suggestions]),
    [["grammatcal", ["grammatical"]]]);
    assert.deepEqual(checked.review.map(issue => issue.word), ["Shukla", "Grammatcal", "Missspelled"]);
  } finally { await checker.dispose(); }
});

test("ranked dictionary guesses cannot singularize an unfamiliar plural", async () => {
  const checker = await createProseChecker();
  try {
    const checked = await checker.check("packages/a/src/a.ts",
      "// Update the undo stack with the revertibles.\n// A missspelled word is ready.\n");
    assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
      .map(issue => issue.word), ["missspelled"]);
    assert.ok(checked.review.some(issue => issue.word === "revertibles"));
  } finally { await checker.dispose(); }
});

test("Conversa proper-name plurals stay review-only beside confirmed typos", async () => {
  const checker = await createProseChecker(["Conversa"]);
  try {
    const checked = await checker.check("packages/a/src/a.ts",
      "// Agent card Conversas are read-only suggestions and don't need a compose box.\n" +
      "// Conversa components contain a missspelled label.\n");
    assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
      .map(issue => [issue.word, issue.suggestions]), [["missspelled", ["misspelled"]]]);
    assert.ok(checked.review.some(issue => issue.word === "Conversas"));
  } finally { await checker.dispose(); }
});

test("quoted code calls preserve spelling and casing while prose typos remain correctable", async () => {
  const checker = await createProseChecker();
  try {
    for (const file of ["packages/a/src/a.ts", "packages/a/README.md"]) {
      const text = '/**\n * Helper to translate CSS color to RGB color string.\n' +
        ' * @returns RGB color string e.g. "rgb(15, 15, 15)"\n' +
        ' * Call \'missspelled("intial")\' or "rgb(0, 0, 0)".\n' +
        ' * A missspelled label uses rgb. The RGB color is ready.\n */\n';
      const checked = await checker.check(file, text);
      assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
        .map(issue => [issue.line, issue.word, issue.suggestions]),
      [[5, "rgb", ["RGB"]], [5, "missspelled", ["misspelled"]]]);
      assert.equal(checked.prose.length, text.length);
    }
  } finally { await checker.dispose(); }
});

test("ranked substitutions hold technical terms while explicit typos remain correctable", async () => {
  const checker = await createProseChecker();
  try {
    const checked = await checker.check("packages/a/src/a.ts",
      "// See 'spec: unsteppable units'. The unsteppable units need review.\n" +
      "// The entrancy term needs review. A missspelled word is teh result.\n");
    assert.equal(checker.dictionary.getPreferredSuggestions("unsteppable").length, 0);
    assert.equal(checker.dictionary.getPreferredSuggestions("entrancy").length, 0);
    assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
      .map(issue => [issue.word, issue.suggestions]),
    [["missspelled", ["misspelled"]], ["teh", ["the"]]]);
    assert.deepEqual(checked.review.map(issue => issue.word), ["unsteppable", "unsteppable", "entrancy"]);
  } finally { await checker.dispose(); }
});

test("unquoted call notation preserves identifiers beside prose acronyms and typos", async () => {
  const checker = await createProseChecker();
  try {
    for (const file of ["packages/a/src/a.ts", "packages/a/README.md"]) {
      const text = "// The URL is removed when the selector text trips the url() gate.\n" +
        "// Keep url()/src(), rgb(0, 0, 0), and missspelled(nested(1)) intact. RGB is ready.\n" +
        "// A missspelled label uses url (the address).\n";
      const checked = await checker.check(file, text);
      assert.equal(checked.prose.length, text.length);
      assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
        .map(issue => [issue.line, issue.word, issue.suggestions]),
      [[3, "url", ["URL"]], [3, "missspelled", ["misspelled"]]]);
    }
  } finally { await checker.dispose(); }
});

test("ellipsis call placeholders preserve code examples beside prose acronyms and typos", async () => {
  const checker = await createProseChecker();
  try {
    for (const file of ["packages/a/src/a.ts", "packages/a/README.md"]) {
      const checked = await checker.check(file,
        '// The URL is ready. Keep url(...), "url(...)", and missspelled(..., 1) intact.\n' +
        "// A missspelled label uses url (the address).\n");
      assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
        .map(issue => [issue.line, issue.word, issue.suggestions]),
      [[2, "url", ["URL"]], [2, "missspelled", ["misspelled"]]]);
    }
  } finally { await checker.dispose(); }
});

test("dogfood domain fragments remain unchanged beside ordinary prose typos", async () => {
  const checker = await createProseChecker();
  try {
    for (const file of ["packages/a/src/a.ts", "packages/a/README.md"]) {
      const checked = await checker.check(file,
        "// These URLs are restricted to the sharepoint(-df).com domain.\n" +
        "// Keep service(-missspelled).test and service(-url).test intact. The URL is ready.\n" +
        "// A missspelled label uses url.\n");
      assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
        .map(issue => [issue.line, issue.word, issue.suggestions]),
      [[3, "url", ["URL"]], [3, "missspelled", ["misspelled"]]]);
      assert.ok(!checked.review.some(issue => issue.word === "df"));
    }
  } finally { await checker.dispose(); }
});

test("code-block review terms and literals stay intact beside confirmed typos", async () => {
  const checker = await createProseChecker();
  try {
    for (const file of ["packages/a/src/a.ts", "packages/a/README.md"]) {
      const checked = await checker.check(file,
        "// Fraunces is a display font. Render Plotly JSON using Fluent Charts.\n" +
        "// WP uses pnpm test:e2e:wp-oce-validation and test:e2e:wp-release-validation.\n" +
        "// Opening sharepoint-df uses Dogfood (df), dropping the df ring.\n" +
        '// Preserve marker-end="url(#arrowhead)" that Mermaid emits. The URL is ready.\n' +
        "// Do not special-case unshadeable inputs. The base URL uses the base-uri CSP directive.\n" +
        "// A missspelled label has a grammatcal error.\n");
      assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
        .map(issue => [issue.word, issue.suggestions]),
      [["missspelled", ["misspelled"]], ["grammatcal", ["grammatical"]]]);
      for (const word of ["Fraunces", "Plotly", "df", "unshadeable"]) {
        assert.equal(checker.dictionary.getPreferredSuggestions(word).length, 0, word);
        assert.ok(checked.review.some(issue => issue.word === word), word);
      }
    }
  } finally { await checker.dispose(); }
});

test("colon-delimited command identifiers preserve casing without hiding prose labels", async () => {
  const checker = await createProseChecker();
  try {
    for (const file of ["packages/a/src/a.ts", "packages/a/README.md"]) {
      const checked = await checker.check(file,
        "// WP uses test:e2e:wp and wp:validate. Keep test:missspelled intact.\n" +
        "// A missspelled: label uses wp. The WP command is ready.\n");
      assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
        .map(issue => [issue.line, issue.word, issue.suggestions]),
      [[2, "wp", ["WP"]], [2, "missspelled", ["misspelled"]]]);
    }
  } finally { await checker.dispose(); }
});

test("shared-component technical terms stay review-only beside confirmed typos", async () => {
  const checker = await createProseChecker();
  try {
    assert.equal(checker.dictionary.has("memoized"), true);
    for (const word of ["unmemoized", "headlessly", "Upserts", "sx", "sv", "bg"]) {
      assert.equal(checker.dictionary.getPreferredSuggestions(word).length, 0, word);
      const checked = await checker.check("packages/a/src/a.ts",
        `// The ${word} term is used here.\n// A missspelled word is ready.\n`);
      assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
        .map(issue => [issue.word, issue.suggestions]), [["missspelled", ["misspelled"]]], word);
      assert.ok(checked.review.some(issue => issue.word === word), word);
    }
  } finally { await checker.dispose(); }
});

test("telemetry names and inflected dictionary terms remain intact beside confirmed typos", async () => {
  const checker = await createProseChecker();
  try {
    assert.equal(checker.dictionary.has("upsert"), true);
    for (const file of ["packages/a/src/a.ts", "packages/a/README.md"]) {
      const checked = await checker.check(file,
        "// Linux writes straight to the mdsd Fluent socket.\n" +
        "// A string value upserts an entry; a null value deletes it.\n" +
        "// Entries are upserted by upserting values.\n" +
        "// A missspelled label has a grammatcal error.\n");
      for (const word of ["mdsd", "upserts", "upserted", "upserting"]) {
        assert.equal(checker.dictionary.getPreferredSuggestions(word).length, 0, word);
        assert.ok(checked.review.some(issue => issue.word === word), word);
      }
      assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
        .map(issue => [issue.word, issue.suggestions]),
      [["missspelled", ["misspelled"]], ["grammatcal", ["grammatical"]]]);
    }
  } finally { await checker.dispose(); }
});

test("file extensions preserve spelling and casing beside standalone acronym corrections", async () => {
  const checker = await createProseChecker();
  try {
    for (const file of ["packages/a/src/a.ts", "packages/a/README.md"]) {
      const checked = await checker.check(file,
        "// Create the file with .url extension. The URL is ready.\n" +
        "// Keep .missspelled and .svg extensions intact. The SVG is ready.\n" +
        "// A missspelled label uses url and svg.\n");
      assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
        .map(issue => [issue.word, issue.suggestions]),
      [["url", ["URL"]], ["svg", ["SVG"]], ["missspelled", ["misspelled"]]]);
    }
  } finally { await checker.dispose(); }
});

test("hyphenated package and technical terms are not standalone spelling or acronym candidates", async () => {
  const checker = await createProseChecker();
  try {
    for (const file of ["packages/a/src/a.ts", "packages/a/README.md"]) {
      const checked = await checker.check(file,
        "// Use host-ux-backed surfaces and host-ux's generic affordance. The surface UX is ready.\n" +
        "// Callers own the re-entrancy guard. Check the re-entrant implementation.\n" +
        "// A missspelled label uses svg. The SVG component is ready.\n");
      assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
        .map(issue => [issue.word, issue.suggestions]),
      [["svg", ["SVG"]], ["missspelled", ["misspelled"]]]);
    }
  } finally { await checker.dispose(); }
});

test("parsed argument labels are identifiers even when dictionaries suggest corrections", async () => {
  const checker = await createProseChecker();
  try {
    for (const expression of ["send", "new Signal"]) {
      const text = `${expression}(\n  /* mentionees */ [],\n  /* missspelled */ true,\n` +
        "  /* A missspelled label. */ false\n);\n";
      const checked = await checker.check("packages/a/src/a.ts", text);
      assert.equal(checked.prose.length, text.length);
      assert.ok(!checked.prose.includes("mentionees"));
      assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
        .map(issue => [issue.line, issue.word, issue.suggestions]),
      [[4, "missspelled", ["misspelled"]]]);
      assert.ok(!checked.review.some(issue => issue.word === "mentionees"));
    }
  } finally { await checker.dispose(); }
});

test("occurrences are not silently truncated by per-file or duplicate limits", async t => {
  const f = gitFixture(t);
  writeFileSync(path.join(f.repo, "README.md"), "A missspelled word\n".repeat(120));
  f.git("add", "."); f.git("commit", "-m", "many occurrences");
  const result = await checkRepository(f.repo);
  assert.equal(result.findings.find(item => item.file === "README.md").issues.length, 120);
});

test("valid English variants, software terms, packages and identifiers are not spelling errors", async t => {
  const f = gitFixture(t);
  writeFileSync(path.join(f.repo, "package.json"), JSON.stringify({
    name: "@example/scriptor", dependencies: { beachball: "1", tablero: "1", lage: "1" },
  }));
  writeFileSync(path.join(f.repo, "README.md"),
    "The behaviour of this focusable component uses a stylesheet.\n" +
    "The UX CLI uses ODSP, OCE, oce, FRE, EIS, ACN, Slite, Kusto, Scriptor, beachball and tablero.\n" +
    "Microsoft Defender seems to be a bottleneck with Lage. Use lage for builds.\n" +
    "Use ComponentFocusable and some_variable from packages/scriptor/src/file.ts.\n" +
    "Owner: personalalias\n" +
    "The intial result is teh result becuase it is missspelled.\n" +
    "The unfamiliar project name is zzprojectname.\n");
  f.git("add", "."); f.git("commit", "-m", "language regressions");
  const result = await checkRepository(f.repo);
  const words = result.findings.flatMap(finding => finding.issues.filter(issue => issue.kind === "spelling").map(issue => issue.word));
  assert.deepEqual(words.sort(), ["becuase", "intial", "missspelled", "missspelled", "teh"].sort());
  assert.ok(result.reviewFindings.some(finding => finding.issues.some(issue => issue.word === "zzprojectname")));
  assert.ok(!result.reviewFindings.some(finding => finding.issues.some(issue =>
    ["behaviour", "Focusable", "personalalias", "scriptor", "tablero", "beachball"].includes(issue.word))));
  assert.equal(f.git("status", "--porcelain"), "");
});

test("a typo dictionary cannot override declared packages or explicit repository vocabulary", async t => {
  const f = gitFixture(t);
  writeFileSync(path.join(f.repo, "package.json"), JSON.stringify({ devDependencies: { lage: "2" } }));
  writeFileSync(path.join(f.repo, "cspell.json"), JSON.stringify({ words: ["recieve"] }));
  writeFileSync(path.join(f.repo, "README.md"),
    "The Fluid Framework packages are bumped by an OCE Rotation.\n" +
    "Microsoft Defender seems to be a bottleneck with Lage.\n" +
    "Use lage and the recieve project keyword.\n" +
    "The intial result is teh result becuase it is missspelled.\n");
  f.git("add", "."); f.git("commit", "-m", "vocabulary precedence");
  const result = await checkRepository(f.repo);
  const words = result.findings.flatMap(f => f.issues.filter(i => i.kind === "spelling").map(i => i.word));
  assert.deepEqual(words.sort(), ["intial", "teh", "becuase", "missspelled", "missspelled"].sort());
  assert.ok(!result.reviewFindings.some(f => f.issues.some(i => /^(oce|lage|recieve)$/i.test(i.word))));
});

test("BOM Markdown preserves complete words and spelling offsets", async t => {
  const f = gitFixture(t);
  const text = "\uFEFF# Build\r\n\r\nA Document contains a missspelled word.\r\n";
  writeFileSync(path.join(f.repo, "README.md"), text);
  f.git("add", "."); f.git("commit", "-m", "BOM prose");
  const prose = proseText("README.md", text);
  assert.ok(prose.includes("Build"));
  assert.ok(prose.includes("Document"));
  const result = await checkRepository(f.repo);
  const issues = result.findings.find(f => f.file === "README.md").issues.filter(i => i.kind === "spelling");
  assert.deepEqual(issues.map(i => i.word), ["missspelled"]);
  assert.equal(issues[0].line, 3);
  assert.equal(issues[0].column, text.split("\n")[2].indexOf("missspelled") + 1);
});

test("formatting fragments, contact names, quoted test data and encoded tokens are not proposed as fixes", async t => {
  const f = gitFixture(t);
  writeFileSync(path.join(f.repo, "README.md"),
    "**A**zure **R**esource **M**anager templates are used.\n" +
    "| Owner | Fixture Singal (<fixture@example.invalid>) |\n" +
    "The test inserts \"Worl\" before replacing it with \"World\".\n" +
    "The user is mis-classified when %2Etxt is decoded.\n" +
    "The legal word therefor is valid English.\n" +
    "A missspelled word is still detected.\n");
  f.git("add", "."); f.git("commit", "-m", "unsafe spelling proposals");
  const result = await checkRepository(f.repo);
  const words = result.findings.flatMap(f => f.issues.filter(i => i.kind === "spelling").map(i => i.word));
  assert.deepEqual(words, ["missspelled", "missspelled"]);
  assert.ok(result.reviewFindings.some(f => f.issues.some(i =>
    i.word === "therefor" && i.message === "Valid dictionary word; usage requires context review")));
});

test("grammar does not rewrite technical terms, abbreviations or compound-word preferences", async t => {
  const f = gitFixture(t);
  writeFileSync(path.join(f.repo, "README.md"),
    "The callback receives a public file path and a data type.\n" +
    "The setup uses milliseconds and a plaintext filename.\n" +
    "The MCP CLI uses an HTTP API and a UI component.\n");
  f.git("add", "."); f.git("commit", "-m", "conservative grammar");
  const result = await checkRepository(f.repo);
  assert.equal(result.grammarIssues, 0);
});

test("offline grammar catches agreement, articles and repetition with UTF-16 source locations", async t => {
  const f = gitFixture(t);
  const text = "\u{1F600} This is a example.\nHe are ready.\nThe the documentation is ready.\n" +
    "`He are ready. This is a example.`\n";
  writeFileSync(path.join(f.repo, "README.md"), text);
  f.git("add", "."); f.git("commit", "-m", "grammar regressions");
  const result = await checkRepository(f.repo);
  const grammar = result.findings.find(finding => finding.file === "README.md").issues.filter(issue => issue.kind === "grammar");
  const article = grammar.find(issue => issue.message === "Incorrect indefinite article.");
  assert.equal(article.line, 1);
  assert.equal(article.column, text.split("\n")[0].indexOf("a example") + 1);
  assert.deepEqual(article.suggestions, ["an"]);
  assert.ok(grammar.some(issue => issue.line === 2 && issue.category === "Agreement"));
  assert.ok(grammar.some(issue => issue.line === 3 && issue.category === "Repetition"));
  assert.ok(!grammar.some(issue => issue.line === 4));
  assert.equal(readFileSync(path.join(f.repo, "README.md"), "utf8"), text);
});

test("Harper reports punctuation removals in the incomplete icon comment without claiming a complete repair", async t => {
  const f = gitFixture(t);
  const text = "// \u{1F600} if it doesn't have , will randomly select icon from icon palette\r\n" +
    "export const example = \"if it doesn't have , will randomly select icon from icon palette\";\r\n";
  writeFileSync(path.join(f.repo, "a.ts"), text);
  f.git("add", "."); f.git("commit", "-m", "punctuation regression");
  const result = await checkRepository(f.repo);
  const punctuation = result.findings.find(f => f.file === "a.ts").issues.filter(i => i.rule === "CommaFixes");
  assert.equal(punctuation.length, 1);
  assert.equal(punctuation[0].line, 1);
  assert.equal(punctuation[0].column, text.indexOf(" ,") + 1);
  assert.equal(punctuation[0].word, " ");
  assert.equal(punctuation[0].category, "Punctuation");
  assert.deepEqual(punctuation[0].suggestions, ["Remove this text"]);
  assert.deepEqual(punctuation[0].edits, [{ type: "remove", replacement: "" }]);
  const reports = writeReport(path.join(f.root, "reports"), result);
  for (const file of [reports.html, reports.markdown]) {
    assert.match(readFileSync(file, "utf8"), /missing subjects or objects may go undetected/);
    assert.match(readFileSync(file, "utf8"), /Remove this text/);
  }
  assert.equal(readFileSync(path.join(f.repo, "a.ts"), "utf8"), text);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("library grammar catches missing linking verbs and two-word sentences without enabling style rewrites", async t => {
  const f = gitFixture(t);
  writeFileSync(path.join(f.repo, "README.md"),
    "He are.\n\nIf there a value, return it.\n\n" +
    "The callback receives a public file path and a data type.\n\n" +
    "The MCP CLI uses an HTTP API and a UI component.\n");
  f.git("add", "."); f.git("commit", "-m", "broader grammar regressions");
  const result = await checkRepository(f.repo);
  const grammar = result.findings.find(f => f.file === "README.md").issues.filter(i => i.kind === "grammar");
  const shortSentence = grammar.find(i => i.line === 1 && i.rule === "PronounVerbAgreement");
  assert.equal(shortSentence.word, "are");
  assert.deepEqual(shortSentence.suggestions, []);
  assert.ok(grammar.some(i => i.line === 3 && i.rule === "ThereMissingIsClause" &&
    i.edits.some(edit => edit.type === "replace" && edit.replacement === "there is")));
  assert.ok(!grammar.some(i => i.line >= 5));
});

test("language diagnostics catch residual spacing without rewriting code or technical acronyms", async () => {
  const checker = await createProseChecker();
  try {
    const checked = await checker.check("packages/a/src/a.ts",
      "// the result is a misspelled  word.\nexport const text = 'the result is a misspelled  word.';\n");
    assert.ok(checked.issues.some(issue => issue.rule === "Spaces"));
    assert.ok(checked.issues.every(issue => issue.line === 1));
    const technical = await checker.check("packages/a/src/a.ts",
      "// An HTML element supports an SVG icon through an HTTP API.\n");
    assert.equal(technical.issues.length, 0);
  } finally { await checker.dispose(); }
});

test("dictionary-backed acronym casing preserves articles and nearby ordinary words", async () => {
  const checker = await createProseChecker();
  try {
    const text = "// These props are used to add further styling to the React component created from an svg.\n" +
      "// Apply styles to the SVG component. A missspelled label is ready.\n";
    const checked = await checker.check("packages/a/src/a.ts", text);
    assert.deepEqual(checked.issues.map(issue => [issue.word, issue.suggestions]),
      [["svg", ["SVG"]], ["missspelled", ["misspelled"]]]);
    for (const text of [
      "// A cat and a ram are near us. CAT RAM US.\n",
      "// An SVG icon uses an API. A URL identifies a PNG image.\n",
      "// The svg identifier is ready.\nexport const SVG = 'svg';\n",
      "// Use `SVG` and svg identifiers.\n",
    ]) {
      const checked = await checker.check("packages/a/src/a.ts", text);
      assert.ok(!checked.issues.some(issue => issue.kind === "spelling"), text);
    }
  } finally { await checker.dispose(); }
});

test("acronym casing does not override declared repository vocabulary", async () => {
  const checker = await createProseChecker(["svg"]);
  try {
    const checked = await checker.check("packages/a/src/a.ts",
      "// Create an svg image. Apply styles to the SVG component.\n");
    assert.ok(!checked.issues.some(issue => issue.kind === "spelling"));
    assert.ok(checked.issues.some(issue => issue.rule === "AnA"));
  } finally { await checker.dispose(); }
});

test("Canvas HTML articles require casing evidence and never override declared html vocabulary", async () => {
  const checker = await createProseChecker(["html"]);
  try {
    for (const text of [
      "// The existence of an html element allows reuse.\n",
      "// Updates an html element for preview image insertion.\n",
      "/** Extension of an html element to include presence information */\n",
      "// Visual is an html element representing a model node.\n",
      "// Show the node id as an html attribute through developer tools.\n",
    ]) {
      const checked = await checker.check("packages/a/src/a.ts",
        text + "// An HTML element contains a missspelled label.\n");
      assert.deepEqual(checked.issues.filter(issue => issue.kind === "spelling")
        .map(issue => [issue.word, issue.suggestions]), [["missspelled", ["misspelled"]]]);
      assert.ok(checked.issues.some(issue => issue.line === 1 && issue.rule === "AnA"));
      assert.ok(!checked.issues.some(issue => issue.line === 2 && issue.rule === "AnA"));
    }
  } finally { await checker.dispose(); }
});

test("grammar suggestions cannot bridge masked code or alter actual strings and JSX content", async t => {
  const f = gitFixture(t);
  writeFileSync(path.join(f.repo, "README.md"),
    "If there `a` value, return it.\n\n`He are. If there a value, return it.`\n");
  writeFileSync(path.join(f.repo, "a.ts"), "export const example = 'He are. If there a value, return it.';\n");
  writeFileSync(path.join(f.repo, "example.tsx"),
    "export const view = <div>He are. If there a value, return it.</div>;\n");
  f.git("add", "."); f.git("commit", "-m", "grammar safety boundaries");
  const result = await checkRepository(f.repo);
  assert.equal(result.grammarIssues, 0);
});

test("every old finding receives an explicit disposition and the original inventory is preserved", async t => {
  const f = gitFixture(t), directory = path.join(f.root, "reports");
  const old = await checkRepository(f.repo);
  old.version = 1;
  old.findings.find(finding => finding.file === "README.md").issues.push({ line: 2, column: 1, word: "constructor" });
  old.issues++;
  const reports = writeReport(directory, old);
  const original = readFileSync(reports.json, "utf8");
  const result = await checkRepository(f.repo, { previousReport: reports.json });
  assert.equal(result.audit.reviewedOccurrences, old.issues);
  assert.equal(result.audit.dispositions["accepted-dictionary-or-project-term"], 1);
  writeReport(directory, result);
  assert.equal(readFileSync(path.join(directory, "spelling-before-language-review.json"), "utf8"), original);
  assert.equal(JSON.parse(readFileSync(path.join(directory, "spelling-audit.json"))).findings.length, old.issues);
  result.scannerVersion--;
  writeReport(directory, result);
  const rechecked = await checkRepository(f.repo, { previousReport: reports.json });
  assert.equal(rechecked.audit.reviewedOccurrences, old.issues);
  assert.equal(rechecked.audit.dispositions["accepted-dictionary-or-project-term"], 1);
  assert.equal(rechecked.audit.scannerVersion, rechecked.scannerVersion);
});

test("dirty repositories are held without touching authored work", async t => {
  const f = gitFixture(t);
  writeFileSync(path.join(f.repo, "README.md"), "Authored work\n");
  await assert.rejects(checkRepository(f.repo), /clean checkout/);
  assert.equal(readFileSync(path.join(f.repo, "README.md"), "utf8"), "Authored work\n");
});

function reportFixture(t) {
  const f = fixture(t), runtime = path.join(f.root, "runtime");
  const input = { spool_dir: f.root, spelling: { enabled: true, workspace_dir: f.workspace, scan_interval_seconds: 86400 } };
  const { config, agent } = configure(input, "spelling", path.join(f.root, "spelling"));
  assert.equal(agent, null);
  const calls = [];
  let timestamp = new Date("2026-10-05T10:00:00Z");
  const result = { version: 1, repo: f.workspace, commit: "a".repeat(40), scannedAt: timestamp.toISOString(),
    filesScanned: 10, filesWithIssues: 1, issues: 1, skipped: [],
    findings: [{ file: "README.md", issues: [{ line: 1, column: 1, word: "missspelled", suggestions: ["misspelled"] }] }] };
  const call = async (name, args) => { calls.push({ name, args }); return { ...f.preparation, branch: "master" }; };
  const make = options => createSpellingScan({ store: f.store, config, workspace: f.workspace, runtime,
    call, check: async () => result, now: () => timestamp, ...options });
  return { ...f, input, runtime, calls, make, advance: value => { timestamp = new Date(value); } };
}

test("existing daily config refreshes master before report, with no agent or task dispatch", async t => {
  const f = reportFixture(t);
  const first = await f.make()();
  assert.equal(first.dispatched, 0);
  assert.equal(first.filesWithIssues, 1);
  assert.equal(f.calls[0].name, "bohemia_prepare");
  assert.deepEqual(f.calls[0].args, { repoRoot: f.workspace, operation: "branch", branch: "master",
    baseBranch: "master", mode: "checkout", reset: false, runSetup: false, runBuild: false });
  assert.equal(f.store.tasks().length, 0);
  assert.ok(existsSync(first.report));
  await f.make()();
  assert.equal(f.calls.length, 1, "restart does not rescan before next daily interval");
  f.advance("2026-10-06T10:00:00Z");
  await f.make()();
  assert.equal(f.calls.length, 2);
});

test("scanner changes wait for the configured interval without adding configuration options", async t => {
  const f = reportFixture(t);
  await f.make()();
  const file = path.join(f.runtime, "state.json"), state = JSON.parse(readFileSync(file, "utf8"));
  state.scannerVersion--;
  writeFileSync(file, JSON.stringify(state));
  const waiting = await f.make()();
  assert.equal(f.calls.length, 1);
  assert.match(waiting.holding, /policy changed/);
  f.advance("2026-10-06T10:00:00Z");
  await f.make()();
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.tasks().length, 0);
});

test("failed refresh or active workspace cannot publish a report or dispatch work", async t => {
  const f = reportFixture(t);
  await assert.rejects(f.make({ call: async () => { throw new Error("refresh failed"); } })(), /refresh failed/);
  assert.equal(existsSync(path.join(f.runtime, "spelling-todo.md")), false);
  f.put({ id: "other-owner", agent: "perf" });
  await assert.rejects(f.make()(), /owned by an active task/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.tasks().length, 1);
});

test("Spelling still appears in the existing dashboard without an agent definition", async t => {
  const f = reportFixture(t);
  const result = await runnerSnapshot(f.input, f.root, path.join(f.root, "runners"));
  assert.equal(result.runners[0].id, "spelling");
  assert.equal(result.runners[0].intervalSeconds, 86400);
});
