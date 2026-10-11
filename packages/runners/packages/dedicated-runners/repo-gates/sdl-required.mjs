// The Compliance pipeline's "SDL Required ESLint" task, reproduced so a branch is told here rather
// than by a required build. That task does not read the repository's own eslint config: it applies
// the SDL "required" ruleset on its own, which is why a branch can pass `lage lint` and still break
// Compliance. Guardian breaks at Warning, so any result at all is a failure.
//
// The plugin and parser are resolved from the clone under test rather than from beside this file,
// because this gate is shared and the repository is what pins the versions the pipeline uses. The
// plugin's `required` export is a flat config array and is spread as-is: rewriting the rule list by
// hand is how a local copy drifts from the ruleset the pipeline actually enforces.
import { createRequire } from 'node:module';

const clone = (process.env.SDL_CLONE ?? process.cwd()).replace(/\\/g, '/');
let req;
try {
  req = createRequire(`${clone}/package.json`);
  req.resolve('@microsoft/eslint-plugin-sdl');
} catch {
  req = createRequire(`${clone}/node_modules/.pnpm/node_modules/dummy.js`);
}
const sdl = req('@microsoft/eslint-plugin-sdl');

// Matches the task's TargetsESLint glob and its ParserOptions.
const files = ['**/src/**/*.js', '**/src/**/*.jsx', '**/src/**/*.ts', '**/src/**/*.tsx'];

export default [
  { ignores: ['**/node_modules/**', '**/lib/**', '**/dist/**'] },
  ...sdl.configs.required.map((entry) => ({ ...entry, files })),
  {
    files,
    languageOptions: {
      parser: req('@typescript-eslint/parser'),
      parserOptions: { ecmaVersion: 2018, sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
  },
];
