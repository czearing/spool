// Work items whose fix lands in this repository: each names a first-party file and the
// import edge that pins bytes into a shipped chunk.
//
// Parsing is done by the TypeScript compiler API, never by pattern matching over source
// text. The compiler resolves modules the way the build does, distinguishes type-only
// imports (erased, zero bytes) from value imports, and gives exact line positions.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

function loadTypeScript(repoRoot) {
  try {
    return require_(path.join(repoRoot, "node_modules", "typescript"));
  } catch {
    throw new Error(`TypeScript not resolvable from ${repoRoot}; cannot parse source without it.`);
  }
}

// Libraries worth chasing, and the in-repo edit that usually moves them.
//
// `minimal` names the subpath entry points that already ARE the lightweight build of the library.
// Without it the detector collapsed every `zod/*` subpath into one bucket, so a codebase that had
// finished migrating to `zod/v4-mini` looked byte-for-byte identical to one still on the classic
// bundle. The failure was not theoretical: after the migration pull request shipped, this item came
// back reporting MORE edges than before (11 grew to 13, because the migration added imports), with
// the same title telling the agent to break edges that were already as light as the library allows.
// The agent then spent a full cycle proving it - "all 13 import zod/v4-mini, a no-restricted-imports
// guard forbids bare zod, chunk markers show addIssue 0 / _zod 118 / ZodMiniType 2" - and closed it
// with no pull request. The queue reopened it on the next scan, forever.
//
// A detector no amount of correct work can silence is not a detector, it is a constant. Edges that
// already sit on the minimal build are excluded from the count, and a dependency with no remaining
// convertible edge produces no item at all.
const HEAVY_DEPS = new Map([
  ["zod", { remedy: "declare the schema lazily, validate on the server, or hand-roll the check", minimal: ["zod/v4-mini", "zod/mini"] }],
  ["@formatjs/icu-messageformat-parser", { remedy: "precompile messages at build time" }],
  ["intl-messageformat", { remedy: "precompile messages at build time" }],
  ["ajv", { remedy: "move validation behind a server function" }],
  ["lodash", { remedy: "import the single function path instead of the barrel" }],
  ["moment", { remedy: "swap for the platform Intl API" }],
  ["@azure/msal-browser", { remedy: "import dynamically at the point of sign-in" }],
  ["@fluidframework/tree", { remedy: "load behind the route that opens a document" }]
]);

/** True when a specifier is the library's own lightweight entry point, so there is nothing to swap. */
export function isMinimalSpecifier(specifier, minimal) {
  for (const entry of minimal || []) if (specifier === entry) return true;
  return false;
}

const CONCAT_SUFFIX = " modules (concatenated)";

/**
 * Package owning a built module path, split on path segments so `zod` cannot claim
 * `zod-to-json-schema`.
 */
export function packageOfModule(modulePath) {
  const marker = "node_modules/";
  const i = modulePath.lastIndexOf(marker);
  if (i === -1) return null;
  const parts = modulePath.slice(i + marker.length).split("/");
  return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0] || null;
}

const isFirstParty = (p) => !p.includes("node_modules");

/**
 * Canonical absolute path. The compiler returns forward-slash paths while node's path
 * module returns platform separators, so map keys and resolved targets must be brought
 * to one form or graph lookups silently miss.
 */
export function canonical(file) {
  return path.resolve(file).split(path.sep).join("/");
}

/** Collapse runs of whitespace for single-line display, without pattern matching. */
function oneLine(text) {
  const out = [];
  let pendingSpace = false;
  for (const ch of text) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out.push(" ");
    pendingSpace = false;
    out.push(ch);
  }
  return out.join("");
}

/** True when a chartData label is a webpack scope-hoisting group rather than a module. */
function concatAnchor(label) {
  if (!label.endsWith(CONCAT_SUFFIX)) return null;
  const plus = label.lastIndexOf(" + ");
  return plus === -1 ? null : label.slice(0, plus);
}

/**
 * Build a module path from a trail of chartData labels. The tree is nested by directory,
 * so segments must be joined; a scope-hoist group restarts the path with a full prefix,
 * so everything up to and including the last group label is discarded.
 */
function moduledPath(trail) {
  let startAt = 0;
  for (let i = 0; i < trail.length; i += 1) {
    if (concatAnchor(trail[i]) !== null) startAt = i + 1;
  }
  return trail.slice(startAt).join("/");
}

/**
 * Read report.html's embedded chartData. The payload is a JSON array assigned to
 * window.chartData; it is located by string search and balanced-bracket scan rather than
 * by pattern matching, so nested brackets inside strings cannot truncate it.
 */
export function readChartData(reportHtmlPath) {
  const html = fs.readFileSync(reportHtmlPath, "utf8");
  const key = "window.chartData";
  const at = html.indexOf(key);
  if (at === -1) return null;
  const start = html.indexOf("[", at);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  let end = -1;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  return JSON.parse(html.slice(start, end));
}

export function readChunkModules(bundleDir) {
  const data = readChartData(path.join(bundleDir, "report.html"));
  if (!data) return { chunks: [] };

  const chunks = [];
  for (const chunk of data) {
    const leaves = [];
    const walk = (node, trail, group) => {
      const label = node.label || "";
      const nextTrail = trail.concat(label);
      if (node.groups) {
        const anchor = concatAnchor(label);
        for (const child of node.groups) walk(child, nextTrail, anchor || group);
        return;
      }
      leaves.push({ file: moduledPath(nextTrail), statBytes: node.statSize || 0, group });
    };
    for (const child of chunk.groups || []) walk(child, [], null);
    chunks.push({
      asset: chunk.label,
      statBytes: chunk.statSize || 0,
      parsedBytes: chunk.parsedSize || 0,
      gzipBytes: chunk.gzipSize || 0,
      leaves
    });
  }
  return { chunks };
}

/**
 * Parse every source file with the TypeScript compiler and record value imports with
 * their resolved target. Type-only imports are excluded because the compiler erases them
 * and they cost no bytes.
 */
export function readModuleGraph({ srcRoot, repoRoot }) {
  const ts = loadTypeScript(repoRoot);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".d.ts") &&
        !entry.name.includes(".test.") &&
        !entry.name.includes(".spec.")
      ) {
        files.push(full);
      }
    }
  };
  walk(srcRoot);

  const compilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext
  };
  const host = ts.createCompilerHost(compilerOptions, true);
  // Module resolution repeats the same directory probes for every importer of a shared
  // module. Caching per directory turns the dominant cost of this pass into a lookup.
  const resolutionCache = ts.createModuleResolutionCache(
    canonical(srcRoot),
    (fileName) => fileName,
    compilerOptions
  );

  const edges = [];
  const imports = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const outgoing = [];
    for (const statement of source.statements) {
      const isImport = ts.isImportDeclaration(statement);
      const isReexport = ts.isExportDeclaration(statement) && statement.moduleSpecifier;
      if (!isImport && !isReexport) continue;
      const specifierNode = isImport ? statement.moduleSpecifier : statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifierNode)) continue;

      // Erased at compile time: `import type ...` and `import { type X }` only.
      const clause = isImport ? statement.importClause : null;
      if (isImport) {
        if (!clause) continue; // bare side-effect import, keeps no binding but does emit
        if (clause.isTypeOnly) continue;
        const named = clause.namedBindings;
        if (named && ts.isNamedImports(named) && named.elements.every((e) => e.isTypeOnly) && !clause.name) {
          continue;
        }
      } else if (statement.isTypeOnly) {
        continue;
      }

      const specifier = specifierNode.text;
      const resolved = ts.resolveModuleName(specifier, file, compilerOptions, host, resolutionCache)
        .resolvedModule?.resolvedFileName;
      const { line } = source.getLineAndCharacterOfPosition(statement.getStart(source));
      const record = {
        file: path.relative(repoRoot, file).split(path.sep).join("/"),
        local: path.relative(srcRoot, file).split(path.sep).join("/"),
        absolute: file,
        line: line + 1,
        specifier,
        resolved: resolved || null,
        statement: oneLine(statement.getText(source))
      };
      edges.push(record);
      if (resolved && !resolved.includes("node_modules")) outgoing.push(canonical(resolved));
    }
    imports.set(canonical(file), outgoing);
  }
  return { edges, imports, files };
}

/**
 * Which routes actually reach each first-party module, by traversing the resolved import
 * graph from every route entry. This is what makes "only some routes need this" a
 * measurement instead of a guess about directory names.
 */
export function routeReachability({ srcRoot, imports }) {
  const routesDir = path.join(srcRoot, "routes");
  if (!fs.existsSync(routesDir)) return null;

  const ROUTE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
  const isRouteModule = (name) => {
    if (name.includes(".test.") || name.includes(".spec.")) return false;
    if (name.endsWith(".d.ts")) return false; // declarations emit nothing
    return ROUTE_EXTENSIONS.some((ext) => name.endsWith(ext));
  };
  const routeFiles = fs
    .readdirSync(routesDir)
    .filter(isRouteModule)
    .map((f) => path.join(routesDir, f));
  // Exact stem match: "__root.module.css.d.ts" also begins with "__root." but is not the root.
  const isRootRoute = (name) => ROUTE_EXTENSIONS.some((ext) => name === `__root${ext}`);
  const rootFile = routeFiles.find((f) => isRootRoute(path.basename(f)));
  if (!rootFile) {
    throw new Error(`No __root route module found in ${routesDir}; every module would look route-specific.`);
  }
  const routes = routeFiles.filter((f) => f !== rootFile);

  const reach = (entry) => {
    const seen = new Set();
    const stack = [canonical(entry)];
    while (stack.length) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const next of imports.get(file) || []) stack.push(next);
    }
    return seen;
  };

  const universal = reach(rootFile);
  const reachedBy = new Map();
  for (const route of routes) {
    for (const file of reach(route)) {
      if (!reachedBy.has(file)) reachedBy.set(file, new Set());
      reachedBy.get(file).add(path.basename(route));
    }
  }
  return { routeCount: routes.length, reachedBy, universal };
}

/**
 * A dispatcher makes sibling modules mutually exclusive: one file that imports many
 * modules from a directory and selects between them with a switch. Detected from the
 * parsed syntax tree, so an ordinary directory cannot look like one.
 */
function siblingValueBindings({ ts, source, file, siblingAbsDir }) {
  const targetDir = canonical(siblingAbsDir);
  const bindings = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    const text = specifier.text;
    if (!text.startsWith(".")) continue;
    const resolved = canonical(path.resolve(path.dirname(file), text));
    if (path.posix.dirname(resolved) !== targetDir) continue;
    if (clause.name) bindings.add(clause.name.text);
    const named = clause.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) {
      bindings.add(named.name.text);
      continue;
    }
    for (const element of named.elements) {
      if (element.isTypeOnly) continue;
      bindings.add(element.name.text);
    }
  }
  return bindings;
}

/** True when `node` is an identifier read, not a property name or a declaration name. */
function isValueRead(ts, node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  return true;
}

/**
 * A dispatcher is only real when the switch branches actually select between the sibling
 * imports. Counting imports and counting `case` clauses separately proves nothing: a file
 * can import siblings for unrelated reasons and switch on an unrelated enum. So require
 * each branch to reference a binding introduced by one of those imports.
 */
export function findDispatcher({ ts, importerFiles, siblingAbsDir, repoRoot }) {
  for (const [file] of importerFiles) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TSX
    );
    const bindings = siblingValueBindings({ ts, source, file, siblingAbsDir });
    if (bindings.size < 4) continue;

    let best = null;
    const visit = (node) => {
      if (ts.isSwitchStatement(node)) {
        const selected = new Set();
        let branches = 0;
        for (const clause of node.caseBlock.clauses) {
          if (clause.statements.length === 0) continue;
          branches += 1;
          const seen = (child) => {
            if (ts.isIdentifier(child) && bindings.has(child.text) && isValueRead(ts, child)) {
              selected.add(child.text);
            }
            ts.forEachChild(child, seen);
          };
          for (const statement of clause.statements) seen(statement);
        }
        if (selected.size >= 4 && (!best || selected.size > best.selected)) {
          best = { selected: selected.size, branches };
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!best) continue;

    return {
      file: path.relative(repoRoot, file).split(path.sep).join("/"),
      imports: bindings.size,
      selected: best.selected,
      cases: best.branches
    };
  }
  return null;
}

/**
 * How far a stat-share estimate overstates the bytes a dependency actually contributes.
 *
 * A stat size is the ORIGINAL source size webpack recorded for a module. It is taken before
 * minification and, critically, before tree-shaking, so it counts exports that were never
 * emitted at all. Splitting a chunk's measured gzip total in proportion to stat sizes therefore
 * assumes every module both minifies and tree-shakes at the same rate as the chunk average. They
 * do not: dependency source ships with comments, JSDoc and unused exports, while first-party code
 * is already lean.
 *
 * This is measured, not assumed. For zod in the entry chunk of this app:
 *
 *   stat share   162,435 / 1,679,405 = 9.67%  ->  9.67% x 163,164 gzip = 15,782 B  (what we said)
 *   measured                                                             6,137 B  (what it costs)
 *
 * a factor of 2.57. The dependency's own source minifies 8.2x (162,435 -> 19,713 emitted) while
 * the chunk as a whole minifies only 3.3x. Two further items were independently measured by the
 * agent at roughly 8x and 13x overstatement.
 *
 * The bias cannot be removed at source. Per-module parsed and gzip sizes are unavailable here
 * because scope hoisting concatenates the chunk into a single emitted module, which is a
 * documented limitation of bundle analyzers rather than a defect in this tool, and the production
 * build ships no source map to attribute emitted bytes with. Disabling concatenation would make
 * the numbers measurable but would no longer describe the artifact users download.
 *
 * So the estimate is kept, labelled as the upper bound it is, and DISCOUNTED before it is allowed
 * to influence queue order. The divisor is the smallest of the three measured overstatements, so
 * it under-corrects rather than hiding real work.
 */
export const STAT_SHARE_OVERSTATEMENT = 2.57;

/**
 * Upper bound on the bytes a stat-size slice of a chunk contributes.
 *
 * Returns the raw stat-share figure for display AND the discounted figure used for ranking, so a
 * report can show what the analyzer saw while the queue orders on something closer to the truth.
 */
function realBytes(chunk, statBytes) {
  const share = chunk.statBytes ? statBytes / chunk.statBytes : 0;
  const gzip = Math.round((chunk.gzipBytes || 0) * share);
  const parsed = Math.round((chunk.parsedBytes || 0) * share);
  return {
    gzip,
    parsed,
    rankingGzip: Math.round(gzip / STAT_SHARE_OVERSTATEMENT),
    measured: false
  };
}

/** Files nearer the always-loaded path matter most; server-only files matter least. */
function rank(local) {
  if (local.startsWith("routes/__root.")) return 0;
  if (local === "router.tsx" || local === "router.ts") return 1;
  if (local.startsWith("routes/")) return 2;
  if (local.startsWith("serverFunctions/")) return 9;
  return 5;
}

/** Map a built module path to a repo-relative source path. */
function toRepoPath(modulePath, appRel) {
  const prefix = "../packages/";
  if (modulePath.startsWith(prefix)) {
    const rest = modulePath.slice(prefix.length);
    const slash = rest.indexOf("/");
    const pkg = rest.slice(0, slash);
    let tail = rest.slice(slash + 1);
    if (tail.startsWith("lib/")) tail = tail.slice(4);
    if (tail.endsWith(".js")) tail = `${tail.slice(0, -3)}.ts`;
    return `packages/${pkg}/src/${tail}`;
  }
  if (modulePath.startsWith("src/")) return `${appRel}/${modulePath}`;
  return modulePath;
}

/** Absolute source dir for a built module path under packages/<name>/lib/. */
function siblingSourceDir(modulePath, repoRoot) {
  const prefix = "../packages/";
  if (!modulePath.startsWith(prefix)) return null;
  const rest = modulePath.slice(prefix.length);
  const slash = rest.indexOf("/");
  const pkg = rest.slice(0, slash);
  let tail = rest.slice(slash + 1);
  if (!tail.startsWith("lib/")) return null;
  tail = tail.slice(4);
  const dir = path.posix.dirname(tail);
  if (dir === "." || dir === "") return null;
  return path.join(repoRoot, "packages", pkg, "src", ...dir.split("/"));
}

/**
 * The real source file behind a bundle-analyzer leaf label.
 *
 * Framework code splitters emit virtual modules by appending a query to the source path, and
 * the analyzer reports whatever id the bundler used. TanStack Start emits the component half of
 * a route as `src/routes/notebook.$podId.tsx?tsr-split=component` and leaves the loader half
 * under the bare path, and scope hoisting appends ` + N modules` to a label that absorbed
 * others. Comparing raw labels therefore fails to see that both halves are the same file, which
 * is exactly the comparison alreadySplitFiles depends on. Measured on a real report: the entry
 * chunk carried the bare path at 8741 bytes while async/6407 carried the ?tsr-split=component
 * form at 65455 bytes, so the raw strings never matched and the split went unnoticed.
 */
export function normalizeLeafFile(file) {
  let name = String(file || "");
  const query = name.indexOf("?");
  if (query !== -1) name = name.slice(0, query);
  const concat = name.indexOf(" + ");
  if (concat !== -1) name = name.slice(0, concat);
  return name.trim();
}

/**
 * Source files the bundler has already split out of the initial download.
 *
 * A file counts as split when some chunk that is not downloaded on every route also contains
 * it. That is direct evidence from the build output that a lazily-loaded copy exists, so the
 * only thing left behind in the entry chunk is a residue the framework chose to keep eager.
 *
 * Without this, route-specific-code-in-entry fires on frameworks that split routes for you.
 * TanStack Start does exactly that, automatically and with no way to turn it off: it emits the
 * route component into its own async chunk and leaves the loader in the entry, because the
 * generated route tree must statically import every route to match a URL cold. The detector saw
 * the loader residue, concluded the module was eager, and asked for a dynamic import that the
 * build had already performed. An agent burned a full slot proving the component was in
 * async/6407.js before closing it. The premises held for all 14 routes, so this was not one bad
 * item but a detector that could only produce bad items on this repo.
 */
export function alreadySplitFiles(chunks, isEveryRouteAsset) {
  const split = new Set();
  for (const chunk of chunks) {
    if (isEveryRouteAsset(chunk.asset)) continue;
    for (const leaf of chunk.leaves) split.add(normalizeLeafFile(leaf.file));
  }
  return split;
}

export function buildFileItems({ bundleDir, srcRoot, bundleName, rootAssets, repoRoot, appRel }) {
  const { chunks } = readChunkModules(bundleDir);
  if (!srcRoot || !fs.existsSync(srcRoot)) {
    throw new Error(`Source root not found: ${srcRoot}. Import edges cannot be resolved; pass --src.`);
  }
  const ts = loadTypeScript(repoRoot);
  const { edges, imports } = readModuleGraph({ srcRoot, repoRoot });
  const reachability = routeReachability({ srcRoot, imports });
  const isEveryRouteAsset = (asset) => rootAssets.has(asset) || asset.includes("/index.");
  const alreadySplit = alreadySplitFiles(chunks, isEveryRouteAsset);

  // Any file under a package's src, indexed for dispatcher detection.
  const packageGraph = new Map();
  const items = [];

  for (const chunk of chunks) {
    const onEveryRoute = isEveryRouteAsset(chunk.asset);
    const reach = onEveryRoute ? 1 : 0.25;
    const reachBasis = onEveryRoute
      ? "entry chunk, downloaded on every route"
      : "async chunk; reach is a lower bound";

    // (1) Heavy dependency held eagerly by a named first-party import edge.
    //
    // Only meaningful in an INITIAL chunk. The whole remedy is "stop loading this eagerly", so a
    // dependency already sitting in an async chunk is in the desired end state and there is
    // nothing to win. Emitting it anyway produced a real false positive: @azure/msal-browser was
    // reported as an eager edge while it lived only in assets/js/async/1633.*.js, and the agent
    // spent a full cycle proving with a counterfactual build that converting the edge saved zero
    // bytes. An async chunk still costs something when its route loads, but that cost is what the
    // other detectors measure; it is not an eager-load defect.
    for (const [dep, spec] of (onEveryRoute ? HEAVY_DEPS : [])) {
      const remedy = spec.remedy;
      const statBytes = chunk.leaves
        .filter((leaf) => packageOfModule(leaf.file) === dep)
        .reduce((total, leaf) => total + leaf.statBytes, 0);
      if (!statBytes) continue;
      const reachable = edges
        .filter((edge) => edge.specifier === dep || edge.specifier.startsWith(`${dep}/`))
        .sort((a, b) => rank(a.local) - rank(b.local));
      if (!reachable.length) continue;
      // Edges already on the library's lightweight entry point have no swap left in them, so they
      // are reported as context and never counted as work. When every edge is already there the
      // remedy has been applied as far as an import edge can express it, and the item is dropped.
      const importers = reachable.filter((edge) => !isMinimalSpecifier(edge.specifier, spec.minimal));
      if (!importers.length) continue;
      const settled = reachable.length - importers.length;
      const bytes = realBytes(chunk, statBytes);
      // Chunk membership is decided by static reachability: while any eager importer
      // remains, the package stays in this chunk and the saving is zero. The item must
      // therefore commit to converting all of them, and cost is driven by that count.
      const allSites = importers.map((edge) => `${edge.file}:${edge.line}`);
      items.push({
        kind: "eager-dependency-edge",
        title:
          importers.length === 1
            ? `Break the ${dep} import edge in ${importers[0].local}`
            : `Break all ${importers.length} eager ${dep} import edges (start at ${importers[0].local})`,
        file: importers[0].file,
        asset: chunk.asset,
        bundle: bundleName,
        reach,
        reachBasis,
        gzipEstimate: bytes.gzip,
        parsedEstimate: bytes.parsed,
        rankingGzip: bytes.rankingGzip,
        measured: false,
        confidence: 0.75,
        effort: importers.length > 4 ? 3 : importers.length > 1 ? 2 : 1,
        edges: importers,
        detail:
          `${importers.length} first-party file(s) import ${dep} as a value. Webpack places a module in the ` +
          `initial chunk if it is statically reachable from anywhere in it, so ${dep} stays in ${chunk.asset} ` +
          `until every one of these edges is converted or removed — changing only one saves nothing. ` +
          (settled
            ? `${settled} further edge(s) already import the lightweight entry point and are excluded here. `
            : "") +
          `Fix in this repo: ${remedy}.`,
        falsify:
          `Convert all ${importers.length} edge(s) (${allSites.slice(0, 3).join(", ")}${allSites.length > 3 ? ", ..." : ""}), ` +
          `rebuild, and confirm ${chunk.asset} shrinks; converting a subset is expected to change nothing.`
      });
    }

    // (2) Exhaustive static set: sibling modules made mutually exclusive by a dispatcher.
    const byDir = new Map();
    for (const leaf of chunk.leaves) {
      if (!isFirstParty(leaf.file) || !leaf.file.includes("/")) continue;
      const dir = leaf.file.slice(0, leaf.file.lastIndexOf("/"));
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(leaf);
    }
    for (const [dir, members] of byDir) {
      if (members.length < 4) continue;
      const statBytes = members.reduce((total, leaf) => total + leaf.statBytes, 0);
      if (statBytes < 4096) continue;
      const siblingAbsDir = siblingSourceDir(members[0].file, repoRoot);
      if (!siblingAbsDir || !fs.existsSync(siblingAbsDir)) continue;

      const pkgSrc = siblingAbsDir.slice(0, siblingAbsDir.indexOf(`${path.sep}src${path.sep}`) + 5);
      if (!packageGraph.has(pkgSrc)) {
        try {
          packageGraph.set(pkgSrc, readModuleGraph({ srcRoot: pkgSrc, repoRoot }).imports);
        } catch {
          packageGraph.set(pkgSrc, new Map());
        }
      }
      const dispatcher = findDispatcher({
        ts,
        importerFiles: packageGraph.get(pkgSrc),
        siblingAbsDir,
        repoRoot
      });
      if (!dispatcher) continue;

      const bytes = realBytes(chunk, statBytes);
      items.push({
        kind: "exhaustive-static-set",
        title: `Load 1 of ${members.length} variants in ${dir} instead of all of them`,
        file: dispatcher.file,
        asset: chunk.asset,
        bundle: bundleName,
        reach,
        reachBasis,
        gzipEstimate: bytes.gzip,
        parsedEstimate: bytes.parsed,
        rankingGzip: bytes.rankingGzip,
        measured: false,
        confidence: 0.7,
        effort: 2,
        members: members.map((leaf) => ({ file: leaf.file, statBytes: leaf.statBytes })),
        detail:
          `${dispatcher.file} imports ${dispatcher.imports} sibling modules from this directory and its ` +
          `${dispatcher.cases}-case switch returns ${dispatcher.selected} of them directly, so all ` +
          `${members.length} variants ship in ${chunk.asset} while a session uses one. Tree-shaking ` +
          `discriminates between exports, never between switch branches. Fix in this repo: resolve the variant ` +
          `at build time, or load it with a dynamic import keyed on the runtime value.`,
        falsify: `Convert the imports in ${dispatcher.file} to a runtime-keyed dynamic import, rebuild, diff asset bytes.`
      });
    }

    // (3) Route-specific code in the chunk every route downloads. Membership comes from
    // the resolved import graph, not from where the file happens to live.
    if (onEveryRoute && reachability) {
      for (const leaf of chunk.leaves) {
        if (!isFirstParty(leaf.file) || leaf.statBytes < 8192) continue;
        if (!leaf.file.startsWith("src/")) continue;
        if (alreadySplit.has(normalizeLeafFile(leaf.file))) continue; // build already lazy-loads it
        const abs = canonical(path.join(srcRoot, leaf.file.slice(4)));
        if (!fs.existsSync(abs)) continue;
        if (reachability.universal.has(abs)) continue; // genuinely needed everywhere
        const users = reachability.reachedBy.get(abs);
        if (!users || users.size === 0 || users.size >= reachability.routeCount) continue;

        const bytes = realBytes(chunk, leaf.statBytes);
        const named = [...users].sort();
        items.push({
          kind: "route-specific-code-in-entry",
          title: `Load ${path.basename(leaf.file)} from its ${users.size} route(s), not the entry chunk`,
          file: toRepoPath(leaf.file, appRel),
          asset: chunk.asset,
          bundle: bundleName,
          reach: 1,
          reachBasis,
          gzipEstimate: bytes.gzip,
          parsedEstimate: bytes.parsed,
          rankingGzip: bytes.rankingGzip,
          measured: false,
          confidence: 0.65,
          effort: 2,
          routes: named,
          detail:
            `The import graph shows this module is reached by ${users.size} of ${reachability.routeCount} routes ` +
            `(${named.join(", ")}) and is not reached from the root layout, yet it sits in ${chunk.asset}, which ` +
            `every route downloads. Fix in this repo: load it lazily from the route(s) that use it.`,
          falsify: `Convert its import site to a dynamic import, rebuild, and confirm the entry chunk shrinks.`
        });
      }
    }
  }

  for (const item of items) {
    // Rank on the discounted figure, never the headline one. The impact tier is a step function,
    // so an inflated estimate does not just exaggerate an item, it promotes it a whole tier and
    // pushes measured work down the queue. The zod item is the worked example: 15,782 B claimed
    // put it in tier 2, while its measured 6,137 B is tier 1, so a finding the agent went on to
    // reject outranked real work for a full cycle.
    const forRanking = item.measured === false && typeof item.rankingGzip === "number"
      ? item.rankingGzip
      : item.gzipEstimate;
    const tier = forRanking >= 32768 ? 3 : forRanking >= 8192 ? 2 : forRanking >= 2048 ? 1 : 0.5;
    item.score = Number(((item.reach * tier * item.confidence) / item.effort).toFixed(3));
  }

  const seen = new Set();
  return items
    .filter((item) => {
      const key = `${item.kind}|${item.file}|${item.asset}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score || b.gzipEstimate - a.gzipEstimate);
}
