import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { fromMarkdown } from "mdast-util-from-markdown";
import { getDefaultSettings, getDictionary, spellCheckDocument } from "cspell-lib";
import { LocalLinter, Dialect, SuggestionKind } from "harper.js";
import { binaryInlined } from "harper.js/binaryInlined";

export const scannerVersion = 8;

const grammarRules = [
  "PronounVerbAgreement", "PronounInflectionBe", "IAmAgreement", "HavePronoun", "AnA", "RepeatedWords",
  "CommaFixes", "ThereMissingIsClause", "InflectedVerbAfterTo", "MissingTo", "MissingDeterminer",
  "ThereIsAgreement", "MultipleSequentialPronouns", "SomeWithoutArticle", "EverPronounRelPronoun",
  "Spaces",
];

const excluded = /(^|\/)(?:node_modules|vendor|vendors|third_party|third-party|dist|build|generated|__generated__|coverage|snapshots|__snapshots__|\.git|\.github|\.claude|\.copilot|agents|prompts|skills|change)(\/|$)|(?:^|\/)\.azuredevops\/instructions\/|(?:^|\/)(?:AGENTS|CLAUDE|SKILL)\.md$|(?:\.min|\.generated|\.g|\.d)\./i;
const sourceExtension = /\.(?:[cm]?js|jsx|tsx?)$/i;
const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true,
  maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const blank = text => text.replace(/[^\r\n]/g, " ");

export function proseText(file, text) {
  if (excluded.test(file) || /@generated|auto[- ]generated|do not edit|don't edit/i.test(text.slice(0, 2000))) return "";
  const ranges = [];
  if (/\.md$/i.test(file)) {
    const bom = text.startsWith("\uFEFF") ? 1 : 0;
    const tree = fromMarkdown(text.slice(bom));
    const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(text)?.[0].length || 0;
    const visit = node => {
      if (["code", "inlineCode", "html", "link", "linkReference", "image", "imageReference", "definition"].includes(node.type)) return;
      if (node.type === "text" && node.position.start.offset + bom >= frontmatter) {
        ranges.push([node.position.start.offset + bom, node.position.end.offset + bom]);
      }
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
  } else if (sourceExtension.test(file)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error(`Cannot parse source for safe comment scanning: ${file}`);
    const comments = new Map(), literals = [];
    const visit = node => {
      if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) || ts.isJsxText(node) ||
          [ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail].includes(node.kind)) {
        literals.push([node.getStart(source), node.end]);
      }
      for (const comment of [...ts.getLeadingCommentRanges(text, node.pos) || [],
        ...ts.getTrailingCommentRanges(text, node.end) || []]) comments.set(comment.pos, comment);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const comment of comments.values()) {
      if (!literals.some(([start, end]) => comment.pos >= start && comment.pos < end)) ranges.push([comment.pos, comment.end]);
    }
  } else return "";
  const characters = blank(text).split("");
  for (const [start, end] of ranges) {
    for (let index = start; index < end; index++) characters[index] = text[index];
  }
  for (const expression of [
    /\b[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+){1,3}[ \t]*\([ \t]*<?[\w.%+-]+@[\w.-]+\.[a-z]{2,}>?[ \t]*\)/g,
    /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi,
    /(?<!\w)(["'])[\w.%:-]+\1(?!\w)/g,
    /%[0-9a-f]{2}[\w%.-]*/gi,
  ]) {
    for (const match of text.matchAll(expression)) {
      for (let index = match.index; index < match.index + match[0].length; index++) {
        if (!/[\r\n]/.test(characters[index])) characters[index] = " ";
      }
    }
  }
  let prose = characters.join("");
  for (const expression of [
    /(`+)[\s\S]*?\1/g,
    /(?:https?:\/\/|www\.)[^\s<>]+|<[^>]*>/g,
    /@[a-z][a-z-]*(?:[ \t]+\{[^}]*\})?(?:[ \t]+[\w.[\]-]+)?/gi,
    /\{[^}]*\}/g,
    /\b(?:[\w.-]+[/\\])+(?:[\w.-]+)|\b[\w-]+\.(?:tsx?|jsx?|json|md|mjs|cjs|ya?ml|css)\b/g,
    /\b[a-zA-Z]+(?:[A-Z][a-z]+)+\w*|\b\w+_\w+\b/g,
    /^[ \t]*(?:(?:\/[/*]|\*)[ \t]*)?(?:author|owner|maintainer|contact)[ \t]*:[^\r\n]*/gmi,
    /^[ \t]*(?:(?:\/[/*]|\*)[ \t]*)?(?:eslint|prettier|istanbul|c8 ignore|ts-ignore|ts-expect-error|sourceMappingURL|Copyright|@license)[^\r\n]*/gmi,
  ]) prose = prose.replace(expression, blank);
  return prose;
}

export function repositoryWords(repo, files) {
  const words = [];
  for (const name of ["cspell.json", ".cspell.json", ".vscode/settings.json"]) {
    const file = path.join(repo, name);
    let contents;
    try { contents = readFileSync(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const parsed = ts.parseConfigFileTextToJson(file, contents);
    if (parsed.error) throw new Error(`Invalid spelling configuration: ${name}`);
    for (const list of [parsed.config?.words, parsed.config?.["cSpell.words"]]) {
      if (list !== undefined && (!Array.isArray(list) || list.some(word => typeof word !== "string"))) {
        throw new Error(`Invalid spelling word list: ${name}`);
      }
      words.push(...list || []);
    }
  }
  for (const name of files.filter(file => /(?:^|\/)package\.json$/.test(file) && !excluded.test(file))) {
    const manifest = JSON.parse(readFileSync(path.join(repo, name), "utf8"));
    for (const name of [manifest.name, ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.devDependencies || {}), ...Object.keys(manifest.peerDependencies || {})]) {
      if (typeof name !== "string") continue;
      words.push(...name.split(/[@/.-]/).filter(word => /^[a-z]{3,}$/i.test(word)));
    }
  }
  // Reviewed project names and abbreviations, not words accepted by frequency.
  words.push("ODSP", "Kusto", "Cowork", "DMAAS", "OCE", "LWS", "MTS", "MIP", "TSG", "MFS",
    "FFX", "wacbo", "augloop", "Conversa", "atmentions", "mindmap", "Dogfood", "Dogfooding",
    "FRE", "EIS", "ACN", "Slite", "xdescribe");
  return words;
}

function location(text, offset) {
  const before = text.slice(0, offset);
  return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n") };
}

export async function createProseChecker(words = []) {
  const defaults = await getDefaultSettings();
  const settings = { ...defaults, language: "en,en-GB", words,
    dictionaries: [...defaults.dictionaries, "en_us", "en-gb", "en-common-misspellings",
      "typescript", "node", "npm", "css", "html", "powershell", "csharp", "git"],
    minWordLength: 2, maxNumberOfProblems: Number.MAX_SAFE_INTEGER, maxDuplicateProblems: Number.MAX_SAFE_INTEGER };
  settings.ignoreWords = [...defaults.ignoreWords || [], ...words];
  const vocabulary = new Set(words.map(word => word.toLowerCase()));
  const dictionary = await getDictionary(settings);
  const englishDictionary = await getDictionary({ ...defaults, dictionaries: ["en_us", "en-gb"], words: [] });
  const linter = new LocalLinter({ binary: binaryInlined, dialect: Dialect.American });
  const suggestionsCache = new Map();
  try {
    await linter.setup();
    const grammarConfig = Object.fromEntries(Object.keys(await linter.getDefaultLintConfig()).map(rule => [rule, false]));
    for (const rule of grammarRules) {
      if (!Object.hasOwn(grammarConfig, rule)) throw new Error(`Missing supported grammar rule: ${rule}`);
      grammarConfig[rule] = true;
    }
    await linter.setLintConfig(grammarConfig);
    await linter.importWords(words);
  } catch (error) {
    await linter.dispose();
    throw error;
  }
  return {
    dictionary, englishDictionary, vocabulary,
    dispose: () => linter.dispose(),
    async check(file, text) {
      const prose = proseText(file, text);
      if (!prose.trim()) return { issues: [], review: [], prose };
      const checked = await spellCheckDocument(
        { uri: pathToFileURL(path.resolve(file)).toString(), text: prose, languageId: "plaintext", locale: "en,en-GB" },
        { generateSuggestions: false, noConfigSearch: true, unknownWords: "report-all" }, settings);
      if (checked.errors?.length) throw new Error(`Spelling dictionary failure in ${file}: ${checked.errors.map(error => error.message || String(error)).join("; ")}`);
      const issues = [], review = [];
      for (const issue of checked.issues) {
        if (vocabulary.has(issue.text.toLowerCase().replace(/['\u2019]s$/, ""))) continue;
        if (issue.text.toLowerCase() === "mis" && text[issue.offset + issue.text.length] === "-") continue;
        if (isWordFragment(file, text, issue.offset, issue.text)) continue;
        let suggestion = suggestionsCache.get(issue.text);
        if (!suggestion) {
          const preferred = [...new Set(dictionary.getPreferredSuggestions(issue.text).map(item => item.word))];
          const ranked = preferred.length ? [] : englishDictionary.suggest(issue.text, { numSuggestions: 5, numChanges: 2 });
          const best = ranked[0];
          const confident = best && best.cost <= 100 && ranked.every(item =>
            item.word.toLowerCase() === best.word.toLowerCase() || item.cost - best.cost >= 50);
          suggestion = { suggestions: preferred.length ? preferred : confident ? [best.word] : ranked.map(item => item.word),
            confident: preferred.length > 0 || Boolean(confident) };
          suggestionsCache.set(issue.text, suggestion);
        }
        const recognizedEnglish = englishDictionary.has(issue.text);
        const spelling = suggestion.confident && !recognizedEnglish;
        const item = { ...location(text, issue.offset), word: issue.text,
          kind: spelling ? "spelling" : "term", suggestions: suggestion.suggestions,
          message: spelling ? "Possible spelling error; dictionary suggestion" : recognizedEnglish ?
            "Valid dictionary word; usage requires context review" : "Unknown term; may be a name, abbreviation or valid project vocabulary" };
        (spelling ? issues : review).push(item);
      }
      issues.push(...await grammarIssues(linter, prose, text));
      return { issues, review, prose };
    },
  };
}

function isWordFragment(file, text, offset, word) {
  const beforeText = text.slice(Math.max(0, offset - 16), offset);
  const afterText = text.slice(offset + word.length, offset + word.length + 16);
  const before = /\.md$/i.test(file) ? beforeText.replace(/[*_~]+$/, "").slice(-1) : beforeText.slice(-1);
  const after = /\.md$/i.test(file) ? afterText.replace(/^[*_~]+/, "").slice(0, 1) : afterText.slice(0, 1);
  return /[\p{L}\p{N}_]/u.test(before + after) || text.slice(offset, offset + word.length) !== word;
}

async function grammarIssues(linter, prose, text) {
  const issues = [];
  const clean = prose.replace(/^[ \t]*(?:\/\*+|\/\/|\*)[ \t]?/gm, blank).replace(/\*\/[ \t]*$/gm, blank);
  const blocks = [];
  let begin = null, end = 0;
  for (const line of clean.matchAll(/[^\r\n]*(?:\r?\n|$)/g)) {
    const body = line[0].replace(/\r?\n$/, "");
    if (body.trim()) { begin ??= line.index; end = line.index + body.length; }
    else if (begin !== null) { blocks.push({ index: begin, text: clean.slice(begin, end) }); begin = null; }
  }
  for (const block of blocks) {
    const organized = await linter.organizedLints(block.text, { language: "plaintext" });
    for (const [rule, lints] of Object.entries(organized)) for (const lint of lints) {
      try {
        const data = JSON.parse(lint.to_json()), kind = lint.lint_kind(), message = lint.message();
        const start = block.index + data.span.start, end = block.index + data.span.end;
        if (clean.slice(start, end) !== text.slice(start, end) || /[ \t]{3,}/.test(block.text.slice(
          Math.max(0, data.span.start - 12), data.span.end + 12).trim())) continue;
        const edits = lint.suggestions().map(suggestion => {
          try {
            const type = suggestion.kind();
            return { type: type === SuggestionKind.Remove ? "remove" :
              type === SuggestionKind.InsertAfter ? "insertAfter" : "replace",
            replacement: suggestion.get_replacement_text() };
          } finally { suggestion.free(); }
        });
        const suggestions = edits.map(edit => edit.type === "remove" ? "Remove this text" :
          edit.type === "insertAfter" ? `Insert after: ${edit.replacement}` : edit.replacement);
        issues.push({ ...location(text, start), word: text.slice(start, end), kind: "grammar",
          category: kind, rule, message, suggestions, edits });
      } finally { lint.free(); }
    }
  }
  return issues;
}

export async function checkRepository(repo, { observe = () => {}, previousReport } = {}) {
  if (git(repo, ["status", "--porcelain"]).trim()) throw new Error("Spelling scan requires a clean checkout; no changes were made");
  const commit = git(repo, ["rev-parse", "HEAD"]).trim();
  const files = git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const previous = previousReport && existsSync(previousReport) ? JSON.parse(readFileSync(previousReport, "utf8")) : null;
  const originalFile = previousReport && path.join(path.dirname(previousReport), "spelling-before-language-review.json");
  const baseline = previous?.version === 1 ? previous : previous?.scannerVersion !== scannerVersion &&
    originalFile && existsSync(originalFile) ? JSON.parse(readFileSync(originalFile, "utf8")) : null;
  const previousFiles = new Map((baseline?.findings || []).map(finding => [finding.file, finding.issues]));
  const auditFindings = [], findings = [], reviewFindings = [], skipped = [];
  let scanned = 0;
  const checker = await createProseChecker(repositoryWords(repo, files));
  const { vocabulary, dictionary } = checker;
  try {
  for (const file of files) {
    if (excluded.test(file) || !/\.md$/i.test(file) && !sourceExtension.test(file)) continue;
    const absolute = path.join(repo, file);
    if (!lstatSync(absolute).isFile()) { skipped.push({ file, reason: "Not a regular file" }); continue; }
    const text = readFileSync(absolute, "utf8");
    observe({ scanProgress: { filesScanned: scanned, filesWithIssues: findings.length, currentFile: file } });
    const prose = proseText(file, text);
    if (!prose.trim()) {
      for (const issue of previousFiles.get(file) || []) auditFindings.push({ file, ...issue, disposition: "excluded-nonprose" });
      previousFiles.delete(file);
      continue;
    }
    const { issues, review } = await checker.check(file, text);
    if (issues.length) findings.push({ file, issues });
    if (review.length) reviewFindings.push({ file, issues: review });
    const current = new Map([...issues, ...review].filter(issue => issue.kind !== "grammar")
      .map(issue => [`${issue.line}:${issue.column}:${issue.word}`, issue]));
    const lineOffsets = [0];
    for (let index = 0; index < text.length; index++) if (text[index] === "\n") lineOffsets.push(index + 1);
    for (const issue of previousFiles.get(file) || []) {
      const retained = current.get(`${issue.line}:${issue.column}:${issue.word}`);
      const offset = lineOffsets[issue.line - 1] + issue.column - 1;
      const unchanged = text.slice(offset, offset + issue.word.length) === issue.word;
      const disposition = !unchanged ? "source-changed" : retained ? retained.kind === "spelling" ?
        "retained-spelling" : "needs-term-review" : !prose.slice(offset, offset + issue.word.length).trim() ?
        "excluded-nonprose" : vocabulary.has(issue.word.toLowerCase().replace(/['\u2019]s$/, "")) ||
        dictionary.has(issue.word) ? "accepted-dictionary-or-project-term" :
        isWordFragment(file, text, offset, issue.word) ? "excluded-word-fragment" : "needs-context-review";
      auditFindings.push({ file, ...issue, disposition });
    }
    previousFiles.delete(file);
    scanned++;
  }
  } finally { await checker.dispose(); }
  if (git(repo, ["rev-parse", "HEAD"]).trim() !== commit || git(repo, ["status", "--porcelain"]).trim()) {
    throw new Error("Checkout changed during spelling scan; report was not published");
  }
  for (const [file, issues] of previousFiles) {
    for (const issue of issues) auditFindings.push({ file, ...issue, disposition: "file-unavailable-or-excluded" });
  }
  const audit = baseline ? { scannerVersion, checkedCommit: commit, originalCommit: baseline.commit, originalIssues: baseline.issues,
    reviewedOccurrences: auditFindings.length, uniqueWords: new Set(auditFindings.map(issue => issue.word)).size,
    dispositions: auditFindings.reduce((counts, issue) => {
      counts[issue.disposition] = (counts[issue.disposition] || 0) + 1; return counts;
    }, {}), findings: auditFindings } : previous?.audit || null;
  if (baseline && auditFindings.length !== baseline.issues) throw new Error("Previous spelling inventory audit is incomplete");
  return { version: 2, scannerVersion, repo, commit, scannedAt: new Date().toISOString(), filesScanned: scanned,
    filesWithIssues: findings.length, issues: findings.reduce((count, finding) => count + finding.issues.length, 0),
    spellingIssues: findings.reduce((count, finding) => count + finding.issues.filter(issue => issue.kind === "spelling").length, 0),
    grammarIssues: findings.reduce((count, finding) => count + finding.issues.filter(issue => issue.kind === "grammar").length, 0),
    reviewIssues: reviewFindings.reduce((count, finding) => count + finding.issues.length, 0),
    findings, reviewFindings, audit, skipped };
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const escapeMarkdown = value => String(value).replace(/[\\`|[\]<>]/g, "\\$&").replace(/\r?\n/g, " ");
export function writeReport(directory, result) {
  mkdirSync(directory, { recursive: true });
  const summary = `${result.filesWithIssues} files with ${result.spellingIssues ?? result.issues} spelling and ${result.grammarIssues || 0} grammar candidates; ${result.filesScanned} files scanned. ${result.reviewIssues || 0} uncertain terms are separate, not confirmed mistakes.`;
  const markdown = ["# Spelling todo", "", summary, "", `Repository: ${result.repo}`,
    `Revision: ${result.commit}`, `Scanned: ${result.scannedAt}`, "",
    "Read-only inventory of Markdown prose and JS/TS comments. CSpell and local Harper produce review candidates, not complete proofreading; missing subjects or objects may go undetected. No agent, edits, commits or PRs.", "",
    ...result.findings.flatMap(finding => [
      `- [ ] **${escapeMarkdown(finding.file)}**`,
      "",
      "| Line | Column | Kind | Text | Explanation | Suggestions |", "| --- | --- | --- | --- | --- | --- |",
      ...finding.issues.map(issue => `| ${issue.line} | ${issue.column} | ${issue.kind || "spelling"} | ${escapeMarkdown(issue.word)} | ${escapeMarkdown(issue.message || "")} | ${escapeMarkdown((issue.suggestions || []).join(", "))} |`), "",
    ]),
    "## Uncertain terms (not confirmed mistakes)", "",
    ...(result.reviewFindings || []).flatMap(finding => [
      `- **${escapeMarkdown(finding.file)}**`, ...finding.issues.map(issue =>
        `  - ${issue.line}:${issue.column}: ${escapeMarkdown(issue.word)}`),
    ]),
    ...(result.audit ? ["", `Previous inventory audit: ${result.audit.reviewedOccurrences}/${result.audit.originalIssues} occurrences classified. See spelling-audit.json. Automated classifications are not a claim of manual linguistic review.`] : []),
    ...(result.skipped.length ? ["## Skipped files", ...result.skipped.map(item => `- ${escapeMarkdown(item.file)}: ${item.reason}`)] : []),
  ].join("\n");
  const render = finding => `<details class="file"><summary><input type="checkbox"> ${escapeHtml(finding.file)} <small>(${finding.issues.length})</small></summary><table><thead><tr><th>Location</th><th>Kind</th><th>Text</th><th>Explanation</th><th>Suggestions</th></tr></thead><tbody>${finding.issues.map(issue => `<tr><td>${issue.line}:${issue.column}</td><td>${escapeHtml(issue.kind || "spelling")}</td><td>${escapeHtml(issue.word)}</td><td>${escapeHtml(issue.message || "")}</td><td>${escapeHtml((issue.suggestions || []).join(", "))}</td></tr>`).join("")}</tbody></table></details>`;
  const sections = result.findings.map(render).join("\n") +
    `<details id="uncertain"><summary>Uncertain terms (${result.reviewIssues || 0}) - not confirmed mistakes</summary>${(result.reviewFindings || []).map(render).join("\n")}</details>` +
    (result.audit ? `<p>Previous inventory: ${result.audit.reviewedOccurrences}/${result.audit.originalIssues} occurrences classified automatically. <a href="spelling-audit.json">Complete classification audit</a>; <a href="spelling-before-language-review.json">original inventory</a>. Unresolved words still require review.</p>` : "");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Spelling todo</title><style>body{font:16px system-ui;margin:32px;max-width:1200px;background:#fafafa;color:#222}input[type=search]{padding:10px;width:100%;box-sizing:border-box;margin:16px 0}details{background:white;border:1px solid #ddd;padding:12px;margin:12px 0}summary{cursor:pointer;font-weight:600;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;margin-top:12px}td,th{padding:6px 12px;text-align:left;border-bottom:1px solid #eee}small{font-weight:400;color:#555}</style><h1>Spelling todo</h1><p>${escapeHtml(summary)}</p><p>Read-only scan. No agent assignments or repository edits. CSpell and local Harper produce review candidates, not complete proofreading; missing subjects or objects may go undetected.</p><p>${escapeHtml(result.repo)}<br><small>${escapeHtml(result.commit)} · ${escapeHtml(result.scannedAt)}</small></p><input type="search" placeholder="Filter files or misspelled words" aria-label="Filter findings"><main>${sections || "<p>No spelling candidates found.</p>"}</main><script>document.querySelector('input[type=search]').addEventListener('input',e=>{const q=e.target.value.toLowerCase();for(const file of document.querySelectorAll('.file'))file.hidden=!file.textContent.toLowerCase().includes(q)});document.querySelectorAll('summary input').forEach(input=>input.addEventListener('click',e=>e.stopPropagation()));</script></html>`;
  const files = { markdown: path.join(directory, "spelling-todo.md"), html: path.join(directory, "spelling-todo.html"),
    json: path.join(directory, "spelling-todo.json") };
  if (result.audit && !existsSync(path.join(directory, "spelling-before-language-review.json")) && existsSync(files.json)) {
    copyFileSync(files.json, path.join(directory, "spelling-before-language-review.json"));
  }
  if (result.audit) {
    const auditFile = path.join(directory, "spelling-audit.json"), temporary = `${auditFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(result.audit, null, 2));
    renameSync(temporary, auditFile);
  }
  for (const [key, contents] of [["markdown", markdown], ["html", html], ["json", JSON.stringify(result, null, 2)]]) {
    const temporary = `${files[key]}.${process.pid}.tmp`;
    writeFileSync(temporary, contents);
    renameSync(temporary, files[key]);
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--apply") || args.includes("--verify")) throw new Error("Spelling checker is read-only; apply and agent workflows are not supported");
  const repo = args[args.indexOf("--repo") + 1], output = args[args.indexOf("--output") + 1];
  if (!args.includes("--repo") || !repo || !path.isAbsolute(repo)) throw new Error("--repo requires an absolute checkout path");
  if (!args.includes("--output") || !output || !path.isAbsolute(output)) throw new Error("--output requires an absolute report directory");
  const result = await checkRepository(repo, { previousReport: path.join(output, "spelling-todo.json"),
    observe: update => console.error(JSON.stringify(update)) });
  console.log(JSON.stringify({ ...writeReport(output, result), filesWithIssues: result.filesWithIssues, issues: result.issues }));
}
