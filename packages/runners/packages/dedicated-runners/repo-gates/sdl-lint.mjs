// Runs the SDL "required" ruleset (see sdl-required.mjs) over the paths given on the command line.
//
// Only findings from @microsoft/sdl rules are reported. Everything else ESLint says here is an
// artefact of running a foreign config over this repository: the sources carry eslint-disable
// comments naming rules this config does not define, and ESLint reports each one as "Definition for
// rule ... was not found". A whole-tree run produced 14458 of those against 0 real findings, so
// counting them would fail nearly every branch for something no required check objects to.
import { createRequire } from "node:module";
import path from "node:path";

const clone = process.env.SDL_CLONE ?? process.cwd();
let ESLint;
try {
  const require = createRequire(path.join(clone, "package.json"));
  ESLint = require("eslint").ESLint;
} catch {
  const require = createRequire(path.join(clone, "node_modules/.pnpm/node_modules/dummy.js"));
  ESLint = require("eslint").ESLint;
}

const targets = process.argv.slice(2);
if (targets.length === 0) process.exit(0);

const eslint = new ESLint({
  cwd: clone,
  overrideConfigFile: path.join(import.meta.dirname, "sdl-required.mjs"),
  errorOnUnmatchedPattern: false,
});

const findings = [];
for (const result of await eslint.lintFiles(targets)) {
  for (const m of result.messages) {
    if (m.ruleId?.startsWith("@microsoft/sdl/")) {
      findings.push(`${path.relative(clone, result.filePath)}:${m.line}:${m.column}  error  ${m.message}  ${m.ruleId}`);
    }
  }
}

for (const f of findings) console.log(f);
console.log(`${findings.length} SDL finding(s)`);
process.exit(findings.length > 0 ? 1 : 0);
