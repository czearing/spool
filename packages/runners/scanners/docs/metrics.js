/**
 * The metric set. Every metric produces a number per file, has a budget in the target profile, and a
 * direction. Nothing here needs judgment: the same file always produces the same number, and one
 * command recomputes it.
 *
 * Adding a metric is an entry in this module plus a budget in the target profile. The shared scaffold
 * never learns what any of these mean.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isExcluded } from "./exclusion.js";

/**
 * The absolute path of the measurement entry point, derived from this module's own location so the
 * command written into an issue resolves from whatever directory the agent that receives it stands in.
 */
export const MEASURE_ENTRY_POINT = resolve(dirname(fileURLToPath(import.meta.url)), "measure.js");

export const METRICS = [
  {
    name: "docs.command-validity",
    kind: "both",
    unit: "commands",
    direction: "lower_is_better",
    note: "commands stated in a document or in a source comment that do not resolve against the repository today",
  },
  {
    name: "docs.navigation-cost",
    kind: "markdown",
    unit: "unresolved paths",
    direction: "lower_is_better",
    note: "paths the document names that do not exist anywhere on the way up from the document",
  },
  {
    name: "docs.missing-detail",
    kind: "markdown",
    unit: "sections",
    direction: "lower_is_better",
    note: "sections that instruct without the command, the path or the value",
  },
  {
    name: "docs.restatement",
    kind: "markdown",
    unit: "sections",
    direction: "lower_is_better",
    note: "sections that reproduce source a reader can open directly",
  },
  {
    name: "docs.padding",
    kind: "markdown",
    unit: "sentences",
    direction: "lower_is_better",
    note: "sentences carrying no path, command, number or rule",
  },
  {
    name: "docs.comment-drift",
    kind: "source",
    unit: "symbols",
    direction: "lower_is_better",
    note: "exported symbols, interface and type members whose doc comment names something the declaration no longer has, and members left undocumented beside documented ones",
  },
];

export function metricByName(name) {
  const metric = METRICS.find((entry) => entry.name === name);
  if (!metric) throw new Error(`unknown metric: ${name}`);
  return metric;
}

const PATH_EXTENSIONS = [
  ".md",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".yml",
  ".yaml",
  ".css",
  ".scss",
  ".sh",
  ".ps1",
  ".html",
];

const PATH_ROOTS = new Set([
  "apps",
  "packages",
  "src",
  "tools",
  "scripts",
  "libs",
  "test",
  "tests",
  "docs",
  "config",
]);

const INSTRUCTION_VERBS = [
  "run",
  "install",
  "set",
  "configure",
  "add",
  "update",
  "create",
  "enable",
  "disable",
  "use",
  "call",
  "deploy",
  "register",
  "import",
  "build",
  "start",
  "open",
  "edit",
  "check",
];

const RULE_WORDS = [
  "must",
  "never",
  "always",
  "do not",
  "does not",
  "cannot",
  "required",
  "only",
  "should not",
  "instead of",
];

const COMMON_WORDS = new Set([
  "true",
  "false",
  "null",
  "type",
  "data",
  "value",
  "props",
  "state",
  "index",
  "default",
  "export",
  "import",
  "return",
  "string",
  "number",
  "object",
  "async",
  "await",
  "this",
  "from",
  "with",
  "when",
  "then",
  "that",
  "they",
  "them",
  "into",
  "each",
  "page",
  "name",
  "file",
  "path",
  "test",
  "code",
]);

export function splitFences(text) {
  const lines = text.split(/\r?\n/);
  const prose = [];
  const fences = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      fences.push(line);
      continue;
    }
    if (inFence) fences.push(line);
    else prose.push(line);
  }
  return { prose: prose.join("\n"), fenced: fences.join("\n"), hasFence: fences.length > 0 };
}

export function parseSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = { heading: "", level: 0, lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = inFence ? null : line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      sections.push(current);
      current = { heading: heading[2].trim(), level: heading[1].length, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);
  return sections
    .map((section) => ({ ...section, body: section.lines.join("\n") }))
    .filter((section) => section.heading !== "" || section.body.trim() !== "");
}

function cleanToken(token) {
  return token.replace(/[)\]},.;:'"`]+$/, "").split("#")[0].split("?")[0];
}

/**
 * Path shaped claims in a document. A package specifier, a url and a glob are not claims about where
 * a file lives, so none of them are counted.
 */
export function pathTokens(text) {
  const found = new Set();
  const pattern = /(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.-]+/g;
  const withoutUrls = text.replace(/[a-z]+:\/\/\S+/gi, " ");
  let match;
  while ((match = pattern.exec(withoutUrls)) !== null) {
    const token = cleanToken(match[0]);
    if (token === "" || token.startsWith("@") || token.includes("*")) continue;
    const parts = token.split("/");
    if (parts.length < 2) continue;
    const hasExtension = PATH_EXTENSIONS.some((extension) => token.toLowerCase().endsWith(extension));
    const rooted = token.startsWith("./") || token.startsWith("../") || PATH_ROOTS.has(parts[0]) || parts[0] === ".github";
    if (!hasExtension && !rooted) continue;
    found.add(token);
  }
  return [...found];
}

export function resolvesOnDisk({ token, repoRoot, relPath }) {
  const local = token.replace(/^\.\//, "").split("/").join(sep);
  const bases = [repoRoot];
  if (relPath) {
    // A document names paths the way its own tree names them, so a claim is resolved from the
    // document outwards: beside it, then from each directory above it, then from the repository root.
    let directory = dirname(relPath);
    while (directory && directory !== "." && directory !== "/") {
      bases.push(join(repoRoot, directory.split("/").join(sep)));
      directory = dirname(directory);
    }
  }
  return bases.some((base) => existsSync(join(base, local)));
}

export function navigationCost({ text, repoRoot, relPath }) {
  const tokens = pathTokens(text).filter((token) => !isExcluded(token));
  const unresolved = tokens.filter((token) => !resolvesOnDisk({ token, repoRoot, relPath }));
  return { value: unresolved.length, evidence: unresolved.slice(0, 5) };
}

function statesAnInstruction(section) {
  const head = section.heading.toLowerCase();
  const sentences = sentencesOf(section.body);
  const starters = [head, ...sentences.map((sentence) => sentence.toLowerCase())];
  return starters.some((line) =>
    INSTRUCTION_VERBS.some((verb) => new RegExp(`(^|\\b)${verb}\\b`).test(line.trim().split(/\s+/).slice(0, 3).join(" "))),
  );
}

function carriesDetail(body, { repoRoot, relPath }) {
  if (/```/.test(body)) return true;
  if (/`[^`\n]+`/.test(body)) return true;
  if (/\d/.test(body)) return true;
  return pathTokens(body).some((token) => resolvesOnDisk({ token, repoRoot, relPath }));
}

export function missingDetail({ text, repoRoot, relPath }) {
  const offenders = parseSections(text)
    .filter((section) => section.heading !== "")
    .filter((section) => statesAnInstruction(section))
    .filter((section) => !carriesDetail(section.body, { repoRoot, relPath }));
  return { value: offenders.length, evidence: offenders.slice(0, 5).map((section) => section.heading) };
}

/**
 * Exported symbol names in the source tree, used as the overlap index for restatement.
 */
export function buildIdentifierIndex({ repoRoot, sourcePaths }) {
  const index = new Set();
  for (const relPath of sourcePaths) {
    let text;
    try {
      text = readFileSync(join(repoRoot, relPath.split("/").join(sep)), "utf8");
    } catch {
      continue;
    }
    const declared = text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g);
    for (const match of declared) index.add(match[1]);
    const listed = text.matchAll(/export\s*\{([^}]*)\}/g);
    for (const match of listed) {
      for (const part of match[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) index.add(name);
      }
    }
  }
  for (const word of COMMON_WORDS) index.delete(word);
  return new Set([...index].filter((name) => name.length >= 4));
}

export const RESTATEMENT_IDENTIFIER_FLOOR = 6;

export function restatement({ text, identifierIndex }) {
  const offenders = [];
  for (const section of parseSections(text)) {
    const words = new Set(section.body.match(/[A-Za-z_$][\w$]*/g) ?? []);
    let hits = 0;
    for (const word of words) if (identifierIndex.has(word)) hits += 1;
    if (hits >= RESTATEMENT_IDENTIFIER_FLOOR) offenders.push({ heading: section.heading, hits });
  }
  return { value: offenders.length, evidence: offenders.slice(0, 5) };
}

export function sentencesOf(body) {
  const withoutHtml = body.replace(/<[^>]+>/g, " ");
  const withoutBullets = withoutHtml.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "");
  return withoutBullets
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length > 0);
}

export const PADDING_MIN_WORDS = 6;

export function padding({ text }) {
  const { prose } = splitFences(text);
  const body = prose.replace(/^#{1,6}\s+.*$/gm, "");
  const offenders = [];
  for (const sentence of sentencesOf(body)) {
    if (sentence.split(/\s+/).length < PADDING_MIN_WORDS) continue;
    if (/`[^`\n]+`/.test(sentence)) continue;
    if (/\d/.test(sentence)) continue;
    if (pathTokens(sentence).length > 0) continue;
    const lowered = sentence.toLowerCase();
    if (RULE_WORDS.some((word) => lowered.includes(word))) continue;
    offenders.push(sentence);
  }
  return { value: offenders.length, evidence: offenders.slice(0, 3) };
}

/**
 * Command validity. A stated command is an invocation a reader can run, and it is read from the two
 * places a command is actually written: a shell fenced block or an inline code span in a document,
 * and a comment in a source file.
 *
 * Three forms are recognised, and nothing else is guessed at:
 * a package script, meaning npm, pnpm, yarn or bun running a named script;
 * a file the command names, meaning node, bash, sh or powershell running a path;
 * a task name, meaning a colon separated name stated on its own inside a code span.
 */

const SHELL_FENCE_INFO = new Set([
  "",
  "sh",
  "bash",
  "shell",
  "zsh",
  "console",
  "terminal",
  "powershell",
  "pwsh",
  "ps",
  "ps1",
  "cmd",
  "bat",
]);

const SCRIPT_RUN = /\b(?:npm|pnpm|yarn|bun)\s+run(?:-script)?\s+([A-Za-z0-9:_.-]+)/g;
const NPM_LIFECYCLE = /\bnpm\s+(test|start)\b/g;
const FILE_RUN = /\b(?:node|bash|sh)\s+((?:\.{1,2}[/\\])?[A-Za-z0-9_./\\-]+\.(?:js|mjs|cjs|ts|sh))/g;
const POWERSHELL_FILE = /\b(?:powershell|pwsh)\s+(?:-[A-Za-z]+\s+)*-File\s+((?:\.{1,2}[/\\])?[A-Za-z0-9_./\\-]+\.ps1)/gi;
const TASK_NAME = /^[a-z][a-z0-9]*(?::[a-z0-9-]+)+$/;

function inlineSpans(line) {
  return (line.match(/`[^`\n]+`/g) ?? []).map((span) => span.slice(1, -1));
}

/**
 * The regions of a document that may hold a command: every line of a shell fenced block, and every
 * inline code span outside a fence.
 */
export function markdownCommandRegions(text) {
  const regions = [];
  let fenceInfo = null;
  for (const line of text.split(/\r?\n/)) {
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      fenceInfo = fenceInfo === null ? fence[1].trim().toLowerCase().split(/\s+/)[0] : null;
      continue;
    }
    if (fenceInfo !== null) {
      if (SHELL_FENCE_INFO.has(fenceInfo)) regions.push({ text: line, inline: false });
      continue;
    }
    for (const span of inlineSpans(line)) regions.push({ text: span, inline: true });
  }
  return regions;
}

/**
 * The regions of a source file that may hold a command: comment text only. A command stated in a
 * comment is counted exactly like one stated in a document.
 */
export function sourceCommandRegions(text) {
  const regions = [];
  const push = (line) => {
    regions.push({ text: line, inline: false });
    for (const span of inlineSpans(line)) regions.push({ text: span, inline: true });
  };
  for (const block of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
    for (const line of block[0].split(/\r?\n/)) push(line.replace(/^\s*\/?\*+\/?/, ""));
  }
  for (const line of text.matchAll(/(?:^|[^:"'`\\/])\/\/(.*)$/gm)) push(line[1]);
  return regions;
}

export function statedCommands({ text, kind }) {
  const regions = kind === "markdown" ? markdownCommandRegions(text) : sourceCommandRegions(text);
  const found = new Map();
  const add = (command) => {
    const key = `${command.form}:${command.name}`;
    if (!found.has(key)) found.set(key, command);
  };

  for (const region of regions) {
    for (const match of region.text.matchAll(SCRIPT_RUN)) add({ form: "script", name: match[1], raw: match[0].trim() });
    for (const match of region.text.matchAll(NPM_LIFECYCLE)) add({ form: "script", name: match[1], raw: match[0].trim() });
    for (const match of region.text.matchAll(FILE_RUN)) {
      add({ form: "file", name: match[1].replace(/\\/g, "/"), raw: match[0].trim() });
    }
    for (const match of region.text.matchAll(POWERSHELL_FILE)) {
      add({ form: "file", name: match[1].replace(/\\/g, "/"), raw: match[0].trim() });
    }
    const trimmed = region.text.trim();
    if (region.inline && TASK_NAME.test(trimmed)) add({ form: "script", name: trimmed, raw: trimmed });
  }

  return [...found.values()];
}

/**
 * A script resolves when a package.json on the way up from the file that states it declares it. The
 * nearest manifest owns the script, and the walk continues upwards because a monorepo states root
 * scripts inside a package tree.
 */
export function packageScriptResolves({ repoRoot, relPath, script }) {
  const directories = [];
  let directory = relPath ? dirname(relPath) : "";
  while (directory && directory !== "." && directory !== "/") {
    directories.push(directory);
    directory = dirname(directory);
  }
  directories.push("");

  for (const entry of directories) {
    const manifest = join(repoRoot, entry.split("/").join(sep), "package.json");
    if (!existsSync(manifest)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      continue;
    }
    const scripts = parsed.scripts ?? {};
    if (Object.prototype.hasOwnProperty.call(scripts, script)) return true;
  }
  return false;
}

export function commandValidity({ text, repoRoot, relPath, kind }) {
  const unresolved = [];
  for (const command of statedCommands({ text, kind })) {
    if (command.form === "file") {
      if (isExcluded(command.name)) continue;
      if (resolvesOnDisk({ token: command.name, repoRoot, relPath })) continue;
      unresolved.push({ command: command.raw, reason: `no file at ${command.name}` });
      continue;
    }
    if (packageScriptResolves({ repoRoot, relPath, script: command.name })) continue;
    unresolved.push({ command: command.raw, reason: `no script named ${command.name} in the package.json that owns it` });
  }
  return { value: unresolved.length, evidence: unresolved.slice(0, 5) };
}

function signatureParameters(head) {
  const open = head.indexOf("(");
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let index = open; index < head.length; index += 1) {
    const character = head[index];
    if (character === "(" || character === "[" || character === "{" || character === "<") depth += 1;
    if (character === ")" || character === "]" || character === "}" || character === ">") {
      depth -= 1;
      if (depth === 0 && character === ")") {
        close = index;
        break;
      }
    }
  }
  if (close === -1) return null;
  const inner = head.slice(open + 1, close);
  const names = new Set();
  for (const part of splitTopLevel(inner)) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      for (const name of trimmed.match(/[A-Za-z_$][\w$]*/g) ?? []) names.add(name);
      continue;
    }
    const match = trimmed.match(/^(?:\.\.\.)?([A-Za-z_$][\w$]*)/);
    if (match) names.add(match[1]);
  }
  return { names, returnType: head.slice(close + 1).split("\n")[0] };
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if ("([{<".includes(character)) depth += 1;
    if (")]}>".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

const MEMBER_TAG = /@(?:param|property|prop|member)\s+(?:\{[^}]*\}\s*)?\[?([A-Za-z_$][\w$]*)/g;

/**
 * The body of a declaration that opens a brace, read by matching braces so a nested member does not
 * end it early. Returns null when the declaration has no body.
 */
export function declarationBody(text, fromIndex) {
  const open = text.indexOf("{", fromIndex);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, index), start: open, end: index };
    }
  }
  return null;
}

/**
 * The members an interface or an object type declares, each with whether it carries its own doc
 * comment. A member is a name at the top level of the body, whether it holds a value or a method.
 */
export function declaredMembers(body) {
  const members = [];
  let depth = 0;
  let documented = false;
  let inComment = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (inComment) {
      if (line.includes("*/")) inComment = false;
      continue;
    }
    if (line.startsWith("/**")) {
      documented = true;
      if (!line.includes("*/")) inComment = true;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("/*")) {
      if (line.startsWith("/*") && !line.includes("*/")) inComment = true;
      continue;
    }
    if (depth === 0) {
      const member = line.match(/^(?:readonly\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\??\s*[:(<]/);
      if (member) members.push({ name: member[1], documented });
      documented = false;
    }
    for (const character of line) {
      if ("({[<".includes(character)) depth += 1;
      if (")}]>".includes(character)) depth -= 1;
    }
    if (depth < 0) depth = 0;
  }
  return members;
}

/**
 * Drift on an interface or an object type. Two things are counted, one member at a time: a member the
 * doc comment names that the declaration no longer has, and a member left undocumented beside
 * members that are documented.
 */
export function memberDrift(text) {
  const offenders = [];
  const pattern = /export\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const symbol = match[1];
    const found = declarationBody(text, match.index + match[0].length);
    if (!found) continue;
    const between = text.slice(match.index + match[0].length, found.start);
    // A type alias only declares members when it is an object literal, so anything else in front of
    // the brace, a union or a generic call, is not a member list.
    if (!/^[\s=<>,A-Za-z_$0-9[\]]*$/.test(between)) continue;

    const members = declaredMembers(found.body);
    if (members.length === 0) continue;

    const before = text.slice(0, match.index);
    const comment = before.match(/\/\*\*([\s\S]*?)\*\/\s*$/);
    const names = new Set(members.map((member) => member.name));
    if (comment) {
      for (const tag of comment[1].matchAll(MEMBER_TAG)) {
        if (names.has(tag[1])) continue;
        offenders.push({ symbol: `${symbol}.${tag[1]}`, reasons: [`documents member ${tag[1]} the declaration does not have`] });
      }
    }

    const anyDocumented = members.some((member) => member.documented);
    if (!anyDocumented) continue;
    for (const member of members) {
      if (member.documented) continue;
      offenders.push({
        symbol: `${symbol}.${member.name}`,
        reasons: ["carries no doc comment beside members that have one"],
      });
    }
  }
  return offenders;
}

export function commentDrift({ text }) {
  const offenders = [];
  const pattern = /\/\*\*([\s\S]*?)\*\//g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const comment = match[1];
    // The declaration is read ahead of the comment without consuming it, so two documented symbols
    // that sit next to each other are both seen.
    const head = text
      .slice(match.index + match[0].length)
      .replace(/^[ \t\r\n]*/, "")
      .split(/\r?\n/)
      .slice(0, 4)
      .join("\n");
    const declaration = head.match(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
    if (!declaration) continue;
    // An interface or an object type is counted a member at a time, so it is left to memberDrift.
    if (/^export\s+(?:declare\s+)?(?:interface|type)\s/.test(head.trimStart())) continue;
    const symbol = declaration[1];
    const signature = signatureParameters(head);
    const documented = [...comment.matchAll(/@param\s+(?:\{[^}]*\}\s*)?\[?([A-Za-z_$][\w$]*)/g)].map((entry) => entry[1]);

    const reasons = [];
    if (signature) {
      for (const name of documented) {
        if (!signature.names.has(name)) reasons.push(`documents parameter ${name} the signature does not have`);
      }
      const returnsNothing = /:\s*(?:void|Promise<void>)\s*[={;]/.test(signature.returnType);
      if (returnsNothing && /@returns?\b/.test(comment)) reasons.push("documents a return value on a signature that returns nothing");
    } else if (documented.length > 0) {
      reasons.push(`documents parameters on ${symbol} which takes none`);
    }

    if (reasons.length > 0) offenders.push({ symbol, reasons });
  }
  offenders.push(...memberDrift(text));
  return { value: offenders.length, evidence: offenders.slice(0, 5) };
}

/**
 * Every number for one file. A file whose number cannot be produced is left out rather than guessed,
 * because a task without a current number is never written.
 */
export function measureFile({ repoRoot, relPath, kind, identifierIndex }) {
  const text = readFileSync(join(repoRoot, relPath.split("/").join(sep)), "utf8");
  const numbers = {};

  numbers["docs.command-validity"] = commandValidity({ text, repoRoot, relPath, kind });

  if (kind === "markdown") {
    numbers["docs.navigation-cost"] = navigationCost({ text, repoRoot, relPath });
    numbers["docs.missing-detail"] = missingDetail({ text, repoRoot, relPath });
    numbers["docs.restatement"] = restatement({ text, identifierIndex: identifierIndex ?? new Set() });
    numbers["docs.padding"] = padding({ text });
  } else if (kind === "source") {
    numbers["docs.comment-drift"] = commentDrift({ text });
  }

  return numbers;
}

export function reproductionCommand(paths) {
  return `node "${MEASURE_ENTRY_POINT}" ${paths.join(" ")}`;
}

export function loadTargets(path) {
  const profile = JSON.parse(readFileSync(path, "utf8"));
  if (!profile.budgets || typeof profile.budgets !== "object") {
    throw new Error(`target profile at ${path} has no budgets`);
  }
  for (const metric of METRICS) {
    if (typeof profile.budgets[metric.name] !== "number") {
      throw new Error(`target profile at ${path} has no budget for ${metric.name}`);
    }
  }
  return profile;
}
