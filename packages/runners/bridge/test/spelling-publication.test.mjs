import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { planBatches, reviewerRules, routing, assertProseOnly } from "../../scanners/spelling/plan.mjs";
import { assertNativeSupport, createSpellingPublisher } from "../../scanners/spelling/publish.mjs";
import { creationContext, createWithOrigin } from "../../packages/bohemia-pr-mcp/src/pr-origin.mjs";
import { createSpellingScan } from "../spelling.mjs";
import { readJson, writeJson } from "../spool-store.mjs";
import { fixture } from "./fixtures.mjs";
import { configure } from "../config.mjs";
import { createUpdater } from "../updater.mjs";
import { createProseChecker, scannerVersion } from "../../scanners/spelling/check.mjs";
import { validatePlan } from "../../scanners/spelling/plan.mjs";
import { regenerateBatch } from "../../scanners/spelling/repair.mjs";

const team = "[OC]\\FluidX_Table";
const rule = (scope, notifyOnly, required = []) => ({ branches: "[Ref] refs/heads/master",
  scope: `[Glob] ${scope}`, required, optional: [], hidden: [], notifyOnly });
const policy = rules => JSON.stringify({ providers: [{ provider: "Ownership/CodeReviewers",
  allowInheritance: true, metadata: { reviewers: rules } }] });
const identities = new Map([[team, { group: true }], ["person", { group: false }], ["other", { group: true }]]);
const issue = (word, column, extra = {}) => ({ word, line: 1, column, kind: "spelling", suggestions: ["misspelled"], ...extra });
const before = "// A missspelled comment.\nexport const value = 1;\n";
const finding = file => ({ file, issues: [issue("missspelled", 6)] });
const plan = (findings, rules, text = before) => planBatches({ commit: "a".repeat(40), findings },
  { rules, identities, read: () => text, english: { has: word => ["example", "unused"].includes(word) } });

test("reviewer policy uses the complete inherited union and keeps mandatory individuals", () => {
  const rules = reviewerRules(policy([rule("/packages/**", [team]), rule("/packages/a/**", [], ["person"])]));
  assert.deepEqual(routing("packages/a/src/file.ts", rules).required, ["person"]);
  const result = plan([finding("packages/a/src/file.ts"), finding("packages/b/src/file.ts")], rules);
  assert.equal(result.batches.length, 1);
  assert.deepEqual(result.batches[0].footprint.required, ["person"]);
  assert.equal(result.batches[0].files.length, 2);
  assert.equal(result.batches[0].area, "Table");
});

test("unrelated reviewer groups and individual-only ownership are not merged", () => {
  const result = plan(["a", "b", "c"].map(pkg => finding(`packages/${pkg}/src/file.ts`)), [
    rule("/packages/a/**", [team]), rule("/packages/b/**", ["other"]), rule("/packages/c/**", ["person"]),
  ]);
  assert.equal(result.batches.length, 3);
  assert.ok(result.batches.every(batch => batch.files.length === 1));
  assert.throws(() => reviewerRules(policy([{ ...rule("/**", []), required: "person" }])), /Unsupported/);
});

test("unresolved reviewer identities visibly hold only their own files", () => {
  const result = plan([finding("packages/a/src/a.ts"), finding("packages/b/src/b.ts")],
    [rule("/packages/a/**", [team]), rule("/packages/b/**", ["retired-person"])]);
  assert.equal(result.batches.length, 1);
  assert.deepEqual(result.held[0].aliases, ["retired-person"]);
  assert.match(result.held[0].reason, /unresolved/);
});

test("ambiguous and overlapping corrections are held with explicit reasons", () => {
  const duplicate = finding("packages/a/src/file.ts");
  duplicate.issues.push({ ...duplicate.issues[0] });
  const result = plan([duplicate], [rule("/**", [team])]);
  assert.equal(result.batches.length, 0);
  assert.equal(result.held.filter(item => /Overlapping/.test(item.reason)).length, 2);
  duplicate.issues = [{ ...duplicate.issues[0], suggestions: ["one", "two"] }];
  assert.equal(plan([duplicate], [rule("/**", [team])]).batches.length, 0);
  assert.throws(() => plan([{ file: duplicate.file, issues: [issue("wrong", 6)] }], [rule("/**", [team])]), /changed/);
});

test("grammar automation only changes existing comma whitespace, not punctuation meaning or technical articles", () => {
  const evaluate = (text, word, replacement, ruleName, column) => plan([{ file: "packages/a/src/a.ts",
    issues: [issue(word, column, { kind: "grammar", rule: ruleName, category: "Punctuation",
      edits: [{ type: "replace", replacement }] })] }], [rule("/**", [team])], text);
  assert.equal(evaluate("// Example , ready.\n", " ,", ",", "CommaFixes", 11).batches.length, 1);
  assert.equal(evaluate("// Example ready.\n", " ", ", ", "CommaFixes", 11).batches.length, 0);
  assert.equal(evaluate("// Use a unused-component.\n", "a", "an", "AnA", 8).batches.length, 0);
  assert.equal(evaluate("// Use a unusedThing.\n", "a", "an", "AnA", 8).batches.length, 0);
  assert.equal(evaluate("// Use a example.\n", "a", "an", "AnA", 8).batches.length, 0);
});

test("real library article and repetition findings cannot corrupt technical prose or meaningful repetitions", async () => {
  const checker = await createProseChecker();
  try {
    for (const text of [
      "// An HTML element contains a node.\n",
      "// Use an SVG icon and an HTTP API with a UI component.\n",
      "// Compare A against B.\n",
      "// Press Ctrl+A in an editor.\n",
      "// The A element is an anchor tag.\n",
      "// A instance is returned.\n",
      "// The cursor in a\u{12000}b follows a surrogate pair.\n",
      "// The cursor in a\u{1F600}b follows a surrogate pair.\n",
      "// Sign in in the Edge window.\n",
      "// Reverse two two-byte groups.\n",
      "// Append them to to the end of the queue.\n",
      "// The the result is ready.\n",
      "// Return an an object.\n",
      "// The object an provide access.\n",
    ]) {
      const checked = await checker.check("packages/a/src/a.ts", text);
      const grammar = checked.issues.filter(issue => issue.kind === "grammar");
      const result = plan([{ file: "packages/a/src/a.ts", issues: grammar }], [rule("/**", [team])], text);
      assert.equal(result.batches.length, 0, text);
      assert.equal(result.held.length, grammar.length, text);
    }
  } finally { await checker.dispose(); }
});

test("Canvas article feedback preserves symbols and holds incomplete prose beside safe typos", async () => {
  const checker = await createProseChecker();
  try {
    for (const [file, line] of [
      ["packages/a/src/a.ts", "// > 0 if A is after B, even if they point to the same position on the shared string"],
      ["packages/a/README.md", "Use Ctrl+A if you want the entire document selected."],
      ["packages/a/src/a.ts", "// Previous element is not here or suitable A element, create a new one"],
      ["packages/a/src/a.ts", "// Create the A element"],
      ["packages/a/README.md", "Group compatible SPANs in an A element."],
      ["packages/a/src/a.ts", "/** @param compared A in a A<B situation. */"],
      ["packages/a/src/a.ts", "// This path strips HTML comments, so A and B"],
      ["packages/a/src/a.ts", "// Valid insertion positions: 0 (before a), 1 (between a and \u{12000}), 3 (between \u{12000} and b), 4 (after b)"],
      ["packages/a/src/a.ts", "// a|\u{12000}b - valid position between a and the surrogate pair"],
      ["packages/a/src/a.ts", "// Valid insertion positions: 0 (before a), 1 (between a and \u{1F600}), 3 (between \u{1F600} and b), 4 (after b)"],
      ["packages/a/README.md", "In such a case the application an provide a custom implementation of Operation Client,"],
      ["packages/a/src/a.ts", "// Writing mode property needs a an additional property setting for text alignment"],
    ]) {
      const prefix = file.endsWith(".md") ? "" : "// ";
      const text = `${line}\n\n${prefix}A missspelled word is ready.\n`;
      const checked = await checker.check(file, text);
      const grammar = checked.issues.filter(issue => issue.kind === "grammar" && issue.line === 1);
      const validated = await validatePlan(plan([{ file, issues: checked.issues }],
        [rule("/**", [team])], text), checker);
      assert.equal(validated.batches[0]?.files[0]?.after,
        `${line}\n\n${prefix}A misspelled word is ready.\n`, line);
      assert.equal(validated.held.filter(item => item.line === 1 &&
        item.reason === "Ambiguous or context-dependent correction").length, grammar.length, line);
      if (line.includes("an provide") || line.includes("a an additional")) {
        assert.ok(grammar.length > 0, line);
      }
    }
  } finally { await checker.dispose(); }
});

test("re-lint holds typo fixes that leave grammar errors or uncertain terms on the edited line", async () => {
  const checker = await createProseChecker();
  try {
    for (const text of ["// A instance contains a missspelled value.\n",
      "// The zzprojectname contains a missspelled value.\n",
      "// The missspelled word is a an example.\n"]) {
      const checked = await checker.check("packages/a/src/a.ts", text);
      const initial = plan([{ file: "packages/a/src/a.ts", issues: checked.issues }], [rule("/**", [team])], text);
      assert.equal(initial.batches.length, 1, text);
      const validated = await validatePlan(initial, checker);
      assert.equal(validated.batches.length, 0, text);
      assert.ok(validated.held.some(item => /unresolved language/.test(item.reason)), text);
    }
    const text = "// A missspelled word is ready.\n";
    const checked = await checker.check("packages/a/src/a.ts", text);
    const initial = plan([{ file: "packages/a/src/a.ts", issues: checked.issues }], [rule("/**", [team])], text);
    assert.equal((await validatePlan(initial, checker)).batches.length, 1);
  } finally { await checker.dispose(); }
});

test("shared-component feedback holds incomplete articles and meaning-bearing repetitions", async () => {
  const checker = await createProseChecker(["ODSP"]);
  const file = "packages/a/src/a.ts";
  try {
    for (const [text, ruleName] of [
      ["/** @param urlResolver A instance of IUrlResolver used to check if a url is a fluid odsp url. */\n", "AnA"],
      ["// such as those in a object argument that has field which may be left undefined.\n", "AnA"],
      ["// Add the tasks we didn't get to to the end of the new task queue\n", "RepeatedWords"],
      ["/**\n" +
        ' * "Note that the order of bytes in the returned byte array is different from the string representation of a Guid value.\n' +
        " *  The order of the beginning four-byte group and the next two two-byte groups is reversed, whereas the order of the last\n" +
        ' *  two-byte group and the closing six-byte group is the same."\n' +
        " */\n", "RepeatedWords"],
    ]) {
      const checked = await checker.check(file, text);
      assert.ok(checked.issues.some(issue => issue.rule === ruleName), text);
      const validated = await validatePlan(plan([{ file, issues: checked.issues }],
        [rule("/**", [team])], text), checker);
      assert.equal(validated.batches.length, 0, text);
      assert.ok(validated.held.some(item => item.reason === "Ambiguous or context-dependent correction"), text);
    }
    for (const [text, expected] of [
      ["// A missspelled instance is returned.\n", "// A misspelled instance is returned.\n"],
      ["// An instance is returned.\n", undefined],
      ["// Add the remaining tasks to the end of the new task queue.\n", undefined],
      ["// Reverse the following two groups of two bytes.\n", undefined],
    ]) {
      const checked = await checker.check(file, text);
      const validated = await validatePlan(plan([{ file, issues: checked.issues }],
        [rule("/**", [team])], text), checker);
      assert.equal(validated.batches[0]?.files[0]?.after, expected, text);
      assert.equal(validated.held.length, 0, text);
    }
  } finally { await checker.dispose(); }
});

test("a clean re-lint does not prove that a missing field article was repaired", async () => {
  const checker = await createProseChecker();
  try {
    for (const text of [
      "// such as those in an object argument that has field which may be left undefined.\n",
      "// such as those in an object argument that has a field which may be left undefined.\n",
    ]) {
      const checked = await checker.check("packages/a/src/a.ts", text);
      assert.equal(checked.issues.length, 0);
      assert.equal(checked.review.length, 0);
    }
  } finally { await checker.dispose(); }
});

test("validated acronym casing repairs lowercase SVG without automating article changes", async () => {
  const checker = await createProseChecker();
  try {
    const text = "// These props are used to add further styling to the React component created from an svg.\n" +
      "// Apply styles to the SVG component.\nexport const svg = 'an svg';\n";
    const checked = await checker.check("packages/a/src/a.ts", text);
    const validated = await validatePlan(plan([{ file: "packages/a/src/a.ts", issues: checked.issues }],
      [rule("/**", [team])], text), checker);
    assert.equal(validated.batches.length, 1);
    assert.equal(validated.batches[0].files[0].after, text.replace("from an svg.", "from an SVG."));
    assert.equal(validated.held.length, 0);
    const wrongArticle = text.replace("from an svg.", "from an svg with a example.");
    const wrongChecked = await checker.check("packages/a/src/a.ts", wrongArticle);
    const held = await validatePlan(plan([{ file: "packages/a/src/a.ts", issues: wrongChecked.issues }],
      [rule("/**", [team])], wrongArticle), checker);
    assert.equal(held.batches.length, 0);
    assert.ok(held.held.some(item => /unresolved language/.test(item.reason)));
  } finally { await checker.dispose(); }
});

test("re-lint keeps safe typo and spacing fixes but holds edited prose lines with bare identifiers", async () => {
  const checker = await createProseChecker();
  try {
    const safeText = "// Wheter  or not the preview is enabled for this renderer.\n";
    const safeChecked = await checker.check("packages/a/src/a.ts", safeText);
    const safeInitial = plan([{ file: "packages/a/src/a.ts", issues: safeChecked.issues }], [rule("/**", [team])], safeText);
    const safeValidated = await validatePlan(safeInitial, checker);
    assert.equal(safeValidated.batches.length, 1);
    assert.equal(safeValidated.batches[0].files[0].after, "// Whether or not the preview is enabled for this renderer.\n");

    const explicitIdentifier = "// Wheter  `EditablePreview` is enabled for this renderer.\n";
    const explicitChecked = await checker.check("packages/a/src/a.ts", explicitIdentifier);
    const explicitInitial = plan([{ file: "packages/a/src/a.ts", issues: explicitChecked.issues }], [rule("/**", [team])],
      explicitIdentifier);
    assert.equal((await validatePlan(explicitInitial, checker)).batches.length, 1);

    const bareIdentifier = "//Wheter  Or not EditablePreview is Enabled for this previewer\n";
    const bareChecked = await checker.check("packages/a/src/a.ts", bareIdentifier);
    const bareInitial = plan([{ file: "packages/a/src/a.ts", issues: bareChecked.issues }], [rule("/**", [team])], bareIdentifier);
    assert.equal(bareInitial.batches.length, 1);
    const bareValidated = await validatePlan(bareInitial, checker);
    assert.equal(bareValidated.batches.length, 0);
    assert.ok(bareValidated.held.some(item => /bare identifier-like token/.test(item.reason)));
  } finally { await checker.dispose(); }
});

test("spacing repairs preserve diagram alignment, Markdown indentation and tool directives", async () => {
  const checker = await createProseChecker();
  try {
    for (const [file, text, expected] of [
      ["packages/a/src/a.ts", "// \u2551 text  \u2551  text \u2551\n// A missspelled word.\n",
        "// \u2551 text  \u2551  text \u2551\n// A misspelled word.\n"],
      ["packages/a/README.md", "- A list item can\n  continue here.\n\nA missspelled word.\n",
        "- A list item can\n  continue here.\n\nA misspelled word.\n"],
      ["packages/a/src/a.ts", "// cspell:ignore  FFXC noopener noreferrer\n// A missspelled word.\n",
        "// cspell:ignore  FFXC noopener noreferrer\n// A misspelled word.\n"],
      ["packages/a/src/a.ts", "// #endregion Insertion Positions  // #region Character Context\n// A missspelled word.\n",
        "// #endregion Insertion Positions  // #region Character Context\n// A misspelled word.\n"],
    ]) {
      const checked = await checker.check(file, text);
      const validated = await validatePlan(plan([{ file, issues: checked.issues }],
        [rule("/**", [team])], text), checker);
      assert.equal(validated.batches[0]?.files[0]?.after, expected, text);
    }
  } finally { await checker.dispose(); }
});

test("parser invariance preserves JSX, template literals, Markdown links and code", () => {
  const jsx = before + "export const view = <div>value</div>;\nexport const text = `literal ${value}`;\n";
  assertProseOnly("a.tsx", jsx, jsx.replace("missspelled", "misspelled").replaceAll("\n", "\r\n"));
  assert.throws(() => assertProseOnly("a.tsx", jsx, jsx.replace("= 1", "= 2")), /Executable/);
  assertProseOnly("a.md", "A missspelled word.\n", "A misspelled word.\n");
  assert.throws(() => assertProseOnly("a.md", "[link](https://example.invalid)\n",
    "[link](https://other.invalid)\n"), /Markdown/);
});

function publication(t) {
  const f = fixture(t);
  writeFileSync(path.join(f.root, "agents", "spelling.md"), "Fix spelling and grammar in comments and Markdown without changing executable code or interfaces.\n");
  const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8",
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(f.workspace, "init", "-b", "master");
  git(f.workspace, "config", "user.name", "Fixture"); git(f.workspace, "config", "user.email", "fixture@example.invalid");
  mkdirSync(path.join(f.workspace, "packages", "a", "src"), { recursive: true });
  mkdirSync(path.join(f.workspace, ".azuredevops", "policies", "branchpolicies", "master"), { recursive: true });
  writeFileSync(path.join(f.workspace, "packages", "a", "src", "a.ts"), before);
  writeFileSync(path.join(f.workspace, ".azuredevops", "policies", "branchpolicies", "master", "requiredReviewers.yml"),
    policy([rule("/packages/**", [team])]));
  git(f.workspace, "add", "."); git(f.workspace, "commit", "-m", "source");
  const publicationRoot = path.join(f.root, "publication");
  git(f.root, "clone", "--quiet", f.workspace, publicationRoot);
  git(publicationRoot, "config", "user.name", "Fixture"); git(publicationRoot, "config", "user.email", "fixture@example.invalid");
  const report = { scannerVersion, repo: f.workspace, commit: git(f.workspace, "rev-parse", "HEAD"),
    findings: [finding("packages/a/src/a.ts")] };
  const runtime = path.join(f.root, "runtime"), prs = [], calls = [], config = {
    publishAgent: "spelling", publicationRoot, ado: { repository: "fixture" },
  };
  let posts = 0;
  const api = { url: (_repo, id) => `https://example.invalid/OC/_git/fixture/pullrequest/${id}`,
    async list(_repo, branch) { return prs.filter(pr => pr.sourceRefName === `refs/heads/${branch}`); },
    async get(_repo, id) { return prs.find(pr => pr.pullRequestId === id); },
    async create(input) {
      posts++;
      const pr = { pullRequestId: 123, sourceRefName: `refs/heads/${input.sourceBranch}`,
        targetRefName: `refs/heads/${input.targetBranch}`, description: input.description, status: "active" };
      prs.push(pr); return pr;
    } };
  const options = { store: f.store, config, runtime, support() {}, identities: async () => identities,
    list: async () => prs.filter(pr => pr.status === "active").map(pr => ({
      id: String(pr.pullRequestId), url: api.url("fixture", pr.pullRequestId),
      branch: pr.sourceRefName.slice(11), status: pr.status })),
    get: async (_cfg, id) => { const pr = await api.get("fixture", Number(id));
      return { ...pr, branch: pr.sourceRefName.slice(11) }; },
    execute: () => "",
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === "bohemia_prepare") {
        assert.equal(args.reset, false);
        if (args.sourceCommit) {
          assert.equal(args.sourceCommit, report.commit);
          git(publicationRoot, "checkout", "-b", args.branch, args.sourceCommit);
        } else {
          assert.equal(args.expectedHead, git(publicationRoot, "rev-parse", args.branch));
          git(publicationRoot, "checkout", args.branch);
        }
        return { ready: true, repoRoot: publicationRoot, branch: args.branch,
          commit: git(publicationRoot, "rev-parse", "HEAD") };
      }
      assert.equal(name, "bohemia_check");
      return { ready: true, commit: git(publicationRoot, "rev-parse", "HEAD") };
    },
    reserve: async ({ id, title, branch, commit }) => {
      f.put({ id, title, agent: "spelling", workspace: publicationRoot, session_id: null,
        deferred_pr_owner: true }, "completed");
      const contextFile = path.join(f.store.records, "creator-contexts", `${id}.json`);
      mkdirSync(path.join(f.store.records, "native-creators"), { recursive: true });
      writeJson(contextFile, { version: 2, nativeRoot: f.root, originKind: "spool_automation",
        taskId: id, agent: "spelling", sessionId: null, workspace: publicationRoot, branch, commit,
        receiptDirectory: path.join(f.store.records, "native-creators"), deferred: true });
      return { taskId: id, deferred: true, contextFile };
    },
    publishCall: async (name, args, options) => {
      assert.equal(name, "bohemia_pr"); assert.equal(args.action, "create");
      assert.equal(options.env.COPILOT_SESSION_ID, "");
      const context = creationContext(options.env);
      return createWithOrigin({ context, input: { ...args, description: args.solution }, repoRoot: publicationRoot, api });
    },
  };
  return { ...f, publicationRoot, report, runtime, config, api, prs, calls, git, options, posts: () => posts,
    publisher: overrides => createSpellingPublisher({ ...options, ...overrides }) };
}

test("automatic creation is scoped, canonical, idempotent and executes zero agents", async t => {
  const f = publication(t), publish = f.publisher();
  assert.equal((await publish(f.report)).created, 1);
  assert.equal((await publish(f.report)).existing, 1);
  assert.equal(f.posts(), 1);
  assert.deepEqual(f.calls.map(call => call.name), ["bohemia_prepare", "bohemia_check"]);
  assert.equal(f.git(f.workspace, "status", "--porcelain"), "");
  const owner = f.store.tasks().find(task => task.agent === "spelling");
  assert.equal(owner.status, "completed"); assert.equal(owner.turns, 0); assert.equal(owner.session_id, null);
  assert.equal(readdirSync(path.join(f.root, "queues", "incoming")).length, 0);
  assert.equal(readdirSync(path.join(f.root, "queues", "in_progress")).length, 0);
});

test("older scanner reports cannot publish even if their source revision is still current", async t => {
  const f = publication(t);
  f.report.scannerVersion = scannerVersion - 1;
  await assert.rejects(f.publisher()(f.report), /rescan before publishing/);
  assert.equal(f.posts(), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.git(f.publicationRoot, "status", "--porcelain"), "");
});

test("engine regeneration restores unsafe published edits and keeps safe typos, code and metadata", async t => {
  const f = publication(t), file = "packages/a/src/a.ts";
  const original = "// Compare A against B. Use an HTML element. Press Ctrl+A.\n" +
    "// Sign in in the Edge window. Reverse two two-byte groups.\n" +
    "// These props style the React component created from an svg. Apply styles to the SVG component.\n" +
    "// A missspelled word is ready.\nexport const value = 1;\n";
  writeFileSync(path.join(f.workspace, "packages", "a", "src", "a.ts"), original);
  writeJson(path.join(f.workspace, "cspell.json"), { words: ["svg"] });
  f.git(f.workspace, "add", "."); f.git(f.workspace, "commit", "-m", "regeneration source");
  const commit = f.git(f.workspace, "rev-parse", "HEAD");
  f.git(f.publicationRoot, "fetch", "origin", "master");
  f.git(f.publicationRoot, "checkout", "-b", "fixture-spelling", commit);
  const unsafe = original.replace("A against", "AN against").replace("an HTML", "a HTML")
    .replace("Ctrl+A", "Ctrl+AN").replace("in in", "in").replace("two two-byte", "two-byte")
    .replace("an svg", "a svg")
    .replace("missspelled", "misspelled");
  writeFileSync(path.join(f.publicationRoot, "packages", "a", "src", "a.ts"), unsafe);
  mkdirSync(path.join(f.publicationRoot, "change"));
  writeJson(path.join(f.publicationRoot, "change", "fixture.json"), { type: "none", dependentChangeType: "none" });
  f.git(f.publicationRoot, "add", "."); f.git(f.publicationRoot, "commit", "-m", "old generated edits");
  const head = f.git(f.publicationRoot, "rev-parse", "HEAD");
  const journal = { version: 1, batches: { fixture: { phase: "published", ownerId: "fixture-owner",
    branch: "fixture-spelling", commit, head, files: [file] } } };
  const options = { repo: f.publicationRoot, journal, owner: "fixture-owner" };
  const preview = await regenerateBatch(options);
  assert.equal(preview.applied, false);
  assert.equal(f.git(f.publicationRoot, "status", "--porcelain"), "");
  assert.equal(preview.files[0].after, original.replace("missspelled", "misspelled"));
  assert.ok(preview.held.some(item => item.line === 3 && item.word === "an"));
  await regenerateBatch({ ...options, apply: true });
  assert.equal(readFileSync(path.join(f.publicationRoot, "packages", "a", "src", "a.ts"), "utf8"),
    original.replace("missspelled", "misspelled"));
  assert.equal(f.git(f.publicationRoot, "diff", "--name-only"), file);
  await assert.rejects(regenerateBatch(options), /exact clean published branch/);
  await assert.rejects(regenerateBatch({ ...options, apply: true }), /exact clean published branch/);
});

test("regeneration refuses executable changes, unknown owners and newer authored commits", async t => {
  const f = publication(t);
  await f.publisher()(f.report);
  const journal = readJson(path.join(f.runtime, "spelling-publications.json")), state = Object.values(journal.batches)[0];
  const options = { repo: f.publicationRoot, journal, owner: state.ownerId, apply: true };
  await assert.rejects(regenerateBatch({ ...options, owner: "unknown" }), /exact publication owner/);
  f.git(f.publicationRoot, "commit", "--allow-empty", "-m", "newer work");
  await assert.rejects(regenerateBatch({ ...options, apply: false }), /exact clean published branch/);
  await assert.rejects(regenerateBatch(options), /exact clean published branch/);
  writeFileSync(path.join(f.publicationRoot, "packages", "a", "src", "a.ts"), before.replace("= 1", "= 2"));
  f.git(f.publicationRoot, "add", "."); f.git(f.publicationRoot, "commit", "-m", "authored executable change");
  state.head = f.git(f.publicationRoot, "rev-parse", "HEAD");
  await assert.rejects(regenerateBatch({ ...options, apply: false }), /Executable code changed/);
});

test("multiple reviewer scopes publish sequentially through one checkout without starting owners", async t => {
  const f = publication(t);
  mkdirSync(path.join(f.workspace, "packages", "b", "src"), { recursive: true });
  writeFileSync(path.join(f.workspace, "packages", "b", "src", "b.ts"), before);
  writeFileSync(path.join(f.workspace, ".azuredevops", "policies", "branchpolicies", "master", "requiredReviewers.yml"),
    policy([rule("/packages/a/**", [team]), rule("/packages/b/**", ["other"])]));
  f.git(f.workspace, "add", "."); f.git(f.workspace, "commit", "-m", "second scope");
  f.git(f.publicationRoot, "fetch", "origin", "master");
  f.report.commit = f.git(f.workspace, "rev-parse", "HEAD");
  f.report.findings.push(finding("packages/b/src/b.ts"));
  const create = f.api.create;
  f.api.create = async input => {
    const pr = await create(input); pr.pullRequestId = 122 + f.posts(); return pr;
  };
  assert.equal((await f.publisher()(f.report)).created, 2);
  assert.equal((await f.publisher()(f.report)).existing, 2);
  assert.equal(f.posts(), 2);
  const owners = f.store.tasks().filter(task => task.agent === "spelling");
  assert.equal(owners.length, 2);
  assert.ok(owners.every(task => task.status === "completed" && task.turns === 0 && task.session_id === null));
  assert.equal(readdirSync(path.join(f.root, "queues", "incoming")).length, 0);
  assert.equal(readdirSync(path.join(f.root, "queues", "in_progress")).length, 0);
});

test("lost POST response reconciles even when the new PR is already listed as active", async t => {
  const f = publication(t), create = f.api.create;
  f.api.create = async input => { await create(input); throw new Error("response lost"); };
  await assert.rejects(f.publisher()(f.report), /response lost/);
  f.api.create = async () => assert.fail("Cannot repeat POST");
  assert.equal((await f.publisher()(f.report)).created, 1);
  assert.equal(f.posts(), 1);
});

test("crash after Git commit but before journal update recovers without another commit or preparation", async t => {
  const f = publication(t);
  await assert.rejects(f.publisher({ execute: () => { throw new Error("metadata unavailable"); } })(f.report), /metadata/);
  const file = path.join(f.runtime, "spelling-publications.json"), journal = readJson(file);
  Object.values(journal.batches)[0].phase = "prepared"; writeJson(file, journal);
  const head = f.git(f.publicationRoot, "rev-parse", "HEAD");
  assert.equal((await f.publisher()(f.report)).created, 1);
  assert.equal(f.git(f.publicationRoot, "rev-parse", "HEAD"), head);
  assert.equal(f.calls.filter(call => call.name === "bohemia_prepare").length, 1);
});

test("commit hooks cannot smuggle executable changes into prose publication", async t => {
  const f = publication(t);
  const execute = () => {
    const file = path.join(f.publicationRoot, "packages", "a", "src", "a.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace("= 1", "= 2"));
    f.git(f.publicationRoot, "add", "."); f.git(f.publicationRoot, "commit", "-m", "mock hook");
  };
  await assert.rejects(f.publisher({ execute })(f.report), /Executable code changed/);
  assert.equal(f.posts(), 0); assert.equal(f.store.tasks().length, 0);
});

test("generated Beachball metadata cannot introduce release bumps", async t => {
  const f = publication(t);
  const execute = () => {
    mkdirSync(path.join(f.publicationRoot, "change"));
    writeJson(path.join(f.publicationRoot, "change", "fixture.json"), { type: "patch", dependentChangeType: "patch" });
    f.git(f.publicationRoot, "add", "."); f.git(f.publicationRoot, "commit", "-m", "mock metadata");
  };
  await assert.rejects(f.publisher({ execute })(f.report), /release bump/);
  assert.equal(f.posts(), 0); assert.equal(f.store.tasks().length, 0);
});

test("failed checks reuse committed metadata without generating another change file", async t => {
  const f = publication(t);
  let generations = 0;
  const execute = () => {
    generations++;
    mkdirSync(path.join(f.publicationRoot, "change"), { recursive: true });
    writeJson(path.join(f.publicationRoot, "change", `${generations}.json`),
      { type: "none", dependentChangeType: "none" });
    f.git(f.publicationRoot, "add", "."); f.git(f.publicationRoot, "commit", "-m", "mock metadata");
  };
  const call = async (name, args) => {
    if (name === "bohemia_check") throw new Error("validation unavailable");
    return f.options.call(name, args);
  };
  await assert.rejects(f.publisher({ execute, call })(f.report), /validation unavailable/);
  const state = Object.values(readJson(path.join(f.runtime, "spelling-publications.json")).batches)[0];
  assert.equal(state.phase, "metadata");
  assert.equal(state.head, f.git(f.publicationRoot, "rev-parse", "HEAD"));
  assert.equal((await f.publisher({ execute })(f.report)).created, 1);
  assert.equal(generations, 1);
  assert.deepEqual(readdirSync(path.join(f.publicationRoot, "change")), ["1.json"]);
});

test("pending publication recovers its exact branch after the generic updater used a published branch", async t => {
  const f = publication(t);
  await f.publisher()(f.report);
  const journalFile = path.join(f.runtime, "spelling-publications.json");
  const first = Object.values(readJson(journalFile).batches)[0];
  f.git(f.publicationRoot, "push", "origin", first.branch);
  mkdirSync(path.join(f.workspace, "packages", "b", "src"), { recursive: true });
  writeFileSync(path.join(f.workspace, "packages", "b", "src", "b.ts"), before);
  writeFileSync(path.join(f.workspace, ".azuredevops", "policies", "branchpolicies", "master", "requiredReviewers.yml"),
    policy([rule("/packages/a/**", [team]), rule("/packages/b/**", ["other"])]));
  f.git(f.workspace, "add", "."); f.git(f.workspace, "commit", "-m", "second scope");
  f.git(f.publicationRoot, "fetch", "origin", "master");
  f.report.commit = f.git(f.workspace, "rev-parse", "HEAD");
  f.report.findings.push(finding("packages/b/src/b.ts"));
  const create = f.api.create;
  f.api.create = async input => { const pr = await create(input); pr.pullRequestId = 122 + f.posts(); return pr; };
  const call = async (name, args) => {
    if (name === "bohemia_check") throw new Error("checks temporarily unavailable");
    return f.options.call(name, args);
  };
  await assert.rejects(f.publisher({ call })(f.report), /temporarily unavailable/);
  const pending = Object.values(readJson(journalFile).batches).find(state => state.phase === "metadata");
  f.git(f.publicationRoot, "checkout", first.branch);
  const preserved = f.git(f.publicationRoot, "rev-parse", "HEAD");
  assert.equal((await f.publisher()(f.report)).created, 1);
  assert.equal(f.git(f.publicationRoot, "rev-parse", first.branch), preserved);
  assert.equal(f.git(f.publicationRoot, "rev-parse", pending.branch), pending.head);
  const recovery = f.calls.find(entry => entry.args.expectedHead === pending.head);
  assert.equal(recovery.args.mode, "checkout");
  assert.equal(recovery.args.reset, false);
  assert.equal(recovery.args.runSetup, false);
  assert.equal(recovery.args.runBuild, false);
});

test("branch recovery refuses dirty or unpublished work without switching either branch", async t => {
  const f = publication(t);
  await assert.rejects(f.publisher({ call: async (name, args) => {
    if (name === "bohemia_check") throw new Error("checks unavailable");
    return f.options.call(name, args);
  } })(f.report), /checks unavailable/);
  const pending = Object.values(readJson(path.join(f.runtime, "spelling-publications.json")).batches)[0];
  f.git(f.publicationRoot, "checkout", "-b", "unrelated-work");
  f.git(f.publicationRoot, "commit", "--allow-empty", "-m", "preserve unpublished work");
  const head = f.git(f.publicationRoot, "rev-parse", "HEAD");
  writeFileSync(path.join(f.publicationRoot, "uncommitted.txt"), "preserve");
  await assert.rejects(f.publisher()(f.report), /both branches preserved/);
  assert.equal(f.git(f.publicationRoot, "branch", "--show-current"), "unrelated-work");
  assert.equal(f.git(f.publicationRoot, "rev-parse", "HEAD"), head);
  assert.equal(f.git(f.publicationRoot, "rev-parse", pending.branch), pending.head);
  assert.equal(readFileSync(path.join(f.publicationRoot, "uncommitted.txt"), "utf8"), "preserve");
});

test("scanner policy changes hold obsolete pending plans without discarding their commits", async t => {
  const f = publication(t);
  await assert.rejects(f.publisher({ call: async (name, args) => {
    if (name === "bohemia_check") throw new Error("checks unavailable");
    return f.options.call(name, args);
  } })(f.report), /checks unavailable/);
  const file = path.join(f.runtime, "spelling-publications.json");
  const original = Object.values(readJson(file).batches)[0], head = original.head;
  f.report.findings = [];
  assert.equal((await f.publisher()(f.report)).created, 0);
  const state = Object.values(readJson(file).batches)[0];
  assert.equal(state.phase, "held"); assert.equal(state.previousPhase, "metadata");
  assert.match(state.reason, /current validated scanner plan/);
  assert.equal(f.git(f.publicationRoot, "rev-parse", original.branch), head);
  assert.equal(f.posts(), 0);
});

test("legacy journal or crash after metadata commit recovers only verified metadata", async t => {
  const f = publication(t);
  const execute = () => {
    mkdirSync(path.join(f.publicationRoot, "change"));
    writeJson(path.join(f.publicationRoot, "change", "fixture.json"),
      { type: "none", dependentChangeType: "none" });
    f.git(f.publicationRoot, "add", "."); f.git(f.publicationRoot, "commit", "-m", "mock metadata");
  };
  const call = async (name, args) => {
    if (name === "bohemia_check") throw new Error("validation unavailable");
    return f.options.call(name, args);
  };
  await assert.rejects(f.publisher({ execute, call })(f.report), /validation unavailable/);
  const file = path.join(f.runtime, "spelling-publications.json"), journal = readJson(file);
  const state = Object.values(journal.batches)[0];
  state.phase = "committed"; state.head = f.git(f.publicationRoot, "rev-parse", "HEAD~1");
  writeJson(file, journal);
  const head = f.git(f.publicationRoot, "rev-parse", "HEAD");
  assert.equal((await f.publisher({ execute: () => assert.fail("Cannot regenerate metadata") })(f.report)).created, 1);
  assert.equal(f.git(f.publicationRoot, "rev-parse", "HEAD"), head);
});

test("changed reviewer policy for generated metadata holds publication", async t => {
  const f = publication(t);
  const execute = () => {
    mkdirSync(path.join(f.publicationRoot, "change"));
    writeJson(path.join(f.publicationRoot, "change", "fixture.json"),
      { type: "none", dependentChangeType: "none" });
    f.git(f.publicationRoot, "add", "."); f.git(f.publicationRoot, "commit", "-m", "mock metadata");
  };
  const reserve = async input => {
    const owner = await f.options.reserve(input);
    writeFileSync(path.join(f.workspace, ".azuredevops", "policies", "branchpolicies", "master", "requiredReviewers.yml"),
      policy([rule("/packages/**", [team]), rule("/change/**", ["other"])]));
    f.git(f.workspace, "add", "."); f.git(f.workspace, "commit", "-m", "reviewer policy");
    f.git(f.publicationRoot, "fetch", "origin", "master");
    return owner;
  };
  await assert.rejects(f.publisher({ execute, reserve })(f.report), /Reviewer policy changed for generated metadata/);
  assert.equal(f.posts(), 0);
});

test("preexisting manual drafts are not duplicated or silently re-owned", async t => {
  const f = publication(t);
  f.prs.push({ pullRequestId: 55, sourceRefName: "refs/heads/user/calebzearing/spelling-table-comments", status: "active" });
  assert.equal((await f.publisher()(f.report)).existing, 1);
  assert.equal(f.posts(), 0); assert.equal(f.store.tasks().length, 0); assert.equal(f.calls.length, 0);
});

test("closed PRs are reconciled rather than reported as open or republished from stale snapshots", async t => {
  const f = publication(t);
  await f.publisher()(f.report);
  f.prs[0].status = "completed";
  const result = await f.publisher()(f.report);
  assert.equal(result.closed, 1); assert.equal(result.existing, 0); assert.equal(f.posts(), 1);
});

test("the existing generic updater alone wakes a dormant spelling owner on a real actionable event", async t => {
  const f = publication(t);
  await f.publisher()(f.report);
  const task = f.store.tasks()[0], remote = f.prs[0];
  const pr = { id: "123", url: f.api.url("fixture", 123), branch: remote.sourceRefName.slice(11),
    targetBranch: "master", description: remote.description, status: "active",
    sourceCommit: f.git(f.publicationRoot, "rev-parse", "HEAD"), title: "Table spelling and grammar fixes",
    mergeStatus: "succeeded", votes: [], reviewers: [] };
  const threads = [];
  const ado = { listOwnPullRequests: async () => [pr], getPullRequest: async () => pr,
    listThreads: async () => threads, listBuilds: async () => [] };
  const config = configure({ spool_dir: f.root, pr_updater: { enabled: true },
    agent_workspaces: { spelling: f.publicationRoot } }, "pr-updater", path.join(f.root, "updater")).config;
  config.creatorMinimumFreeGiB = 0.001;
  const scan = await createUpdater({ store: f.store, config, agent: "pr-updater", runtime: config.runtimeDirectory,
    ado, preparationEvidence: () => "fixture", callBohemia: async (_name, args) =>
      ({ ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: pr.sourceCommit }) });
  assert.equal((await scan()).dispatched, 0);
  assert.equal(f.store.task(task.id).status, "completed");
  threads.push({ id: 42, status: "active", comments: [{ id: 1, commentType: "text",
    author: { displayName: "Agency", descriptor: "s2s.fixture", uniqueName: "" },
    publishedDate: "2026-10-01T00:00:00Z", content: "Ctrl+A must not become Ctrl+AN; fix the engine." }] });
  assert.equal((await scan()).dispatched, 1);
  const queued = f.store.task(task.id);
  assert.equal(queued.status, "incoming"); assert.equal(queued.agent, "spelling");
  assert.equal(queued.session_id, null); assert.equal(queued.turns, 0);
  assert.equal(queued.interaction.messages.length, 1);
  assert.equal(queued.runner_metadata.contract.prId, "123");
  assert.equal(queued.runner_metadata.contract.identifier, task.id);
  assert.equal(queued.runner_metadata.contract.findings[0].threadId, "42");
  assert.match(queued.interaction.messages[0].text, /Current creator instructions/);
  assert.equal(f.posts(), 1);
});

test("publication requires a live native deferred-owner capability", t => {
  const f = fixture(t), file = path.join(f.root, "controls", "capabilities.json"), now = Date.now();
  const capability = { deferredPrOwnersVersion: 1, preparedMessageVersion: 1, interactive: true,
    updatedAt: new Date(now).toISOString() };
  writeJson(file, capability); assertNativeSupport(f.store, now);
  writeJson(file, { ...capability, updatedAt: new Date(now - 15_001).toISOString() });
  assert.throws(() => assertNativeSupport(f.store, now), /live Spool/);
});

test("weekly scans persist pending publication and restart retries do not pull master or rescan", async t => {
  const f = publication(t), config = { ...f.config, pollSeconds: 604800 };
  let clock = new Date("2026-10-06T00:00:00Z"), preparations = 0, scans = 0, publications = 0, fail = true;
  const options = { store: f.store, config, workspace: f.workspace, runtime: f.runtime, support() {},
    now: () => clock, call: async () => { preparations++; return { ready: true, repoRoot: f.workspace,
      branch: "master", commit: f.report.commit }; },
    check: async () => { scans++; return { ...f.report, filesWithIssues: 1, issues: 1 }; },
    report: (runtime, report) => { const files = Object.fromEntries(["markdown", "html", "json"].map(ext =>
      [ext, path.join(runtime, `report.${ext}`)])); for (const file of Object.values(files)) writeJson(file, report); return files; },
    publish: async () => { publications++; if (fail) throw new Error("temporarily held"); return { created: 1 }; } };
  await assert.rejects(createSpellingScan(options)(), /temporarily held/);
  assert.equal(readJson(path.join(f.runtime, "state.json")).publicationPending, true);
  fail = false;
  await createSpellingScan(options)();
  await createSpellingScan(options)();
  assert.equal(preparations, 1); assert.equal(scans, 1); assert.equal(publications, 2);
  clock = new Date(clock.getTime() + 604800_000 - 1);
  await createSpellingScan(options)(); assert.equal(scans, 1);
  clock = new Date(clock.getTime() + 1);
  await createSpellingScan(options)(); assert.equal(scans, 2); assert.equal(preparations, 2);
});
