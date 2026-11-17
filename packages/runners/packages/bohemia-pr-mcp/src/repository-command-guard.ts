import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellStatements } from "./push-scope.ts";

type Profile = {
  repoRoot: string;
  wsl?: { distribution: string; repoRoot: string };
};

const normalize = (value: string) => value.replaceAll("\\", "/")
  .replace(/^\/\/\?\/unc\//i, "//").replace(/^\/\/\?\//, "").replace(/\/+$/, "").toLowerCase();
const managers = /^(?:yarn|npm|npx|pnpm|bun|corepack)(?:\.(?:cmd|exe|ps1|js|cjs|mjs))?$/i;
const runners = /^(?:lage|jest|vitest|tsc|tsgo|eslint|oxlint|rsbuild|rspack|webpack|midgard-scripts)(?:\.(?:cmd|exe|js|cjs|mjs))?$/i;
const scripts = /(?:^|[/\\])(?:[^/\\]*(?:build|bundle|typecheck|lint|test|install|start|serve)[^/\\]*|fast-runner|v\d+\.\d+\.\d+)\.(?:[cm]?js|ts|ps1|sh)$/i;
const toolName = (value: string) => path.posix.basename(value.replaceAll("\\", "/"));

export function registeredLibrary(environment = process.env): Profile | undefined {
  const file = environment.REPOSITORY_MCP_CONFIG ||
    path.join(environment.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "repository-mcp.json");
  if (!fs.existsSync(file)) return undefined;
  const profile = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")).library;
  if (profile === undefined) return undefined;
  if (typeof profile.repoRoot !== "string" ||
      (!path.isAbsolute(profile.repoRoot) && !path.win32.isAbsolute(profile.repoRoot)) ||
      (profile.wsl && (typeof profile.wsl.distribution !== "string" || typeof profile.wsl.repoRoot !== "string")))
    throw new Error("Invalid registered 1JS workspace");
  return profile;
}

export function libraryShellOperation(command: string, initialCwd: string, profile?: Profile): boolean {
  if (!profile) return false;
  const roots = [profile.repoRoot];
  if (profile.wsl) roots.push(profile.wsl.repoRoot,
    `//wsl.localhost/${profile.wsl.distribution}${profile.wsl.repoRoot}`,
    `//wsl$/${profile.wsl.distribution}${profile.wsl.repoRoot}`);
  const inside = (cwd: string) => roots.some(root => normalize(cwd) === normalize(root) ||
    normalize(cwd).startsWith(`${normalize(root)}/`));
  const resolve = (cwd: string, target: string) =>
    /^[a-z]:|^\\\\/i.test(cwd) || /^[a-z]:|^\\\\/i.test(target)
      ? path.win32.resolve(cwd, target) : path.posix.resolve(cwd, target);
  function inspect(source: string | string[][], cwd: string, protectedShell = false, depth = 0): boolean {
    if (depth > 8) return inside(cwd) || protectedShell;
    const stack: string[] = [];
    for (const statement of typeof source === "string" ? shellStatements(source) : source) {
      const tokens = [...statement];
      const program = toolName(tokens.shift() || "");
      if (!program) continue;
      if (/^(?:cd|chdir|set-location|pushd|push-location)$/i.test(program)) {
        if (/^push/i.test(program)) stack.push(cwd);
        const target = tokens.filter(value => !/^(?:-LiteralPath|-Path|\/d)$/i.test(value))[0];
        if (target && !/[$`]/.test(target)) cwd = resolve(cwd, target);
        continue;
      }
      if (/^(?:popd|pop-location)$/i.test(program)) { cwd = stack.pop() || cwd; continue; }
      if (/^wsl(?:\.exe)?$/i.test(program)) {
        const distribution = tokens.findIndex(value => /^(?:-d|--distribution)$/i.test(value));
        const inlineDistribution = tokens.find(value => /^--distribution=/i.test(value));
        const selectedDistribution = distribution >= 0 ? tokens[distribution + 1] : inlineDistribution?.split("=").slice(1).join("=");
        const dedicated = !!profile?.wsl &&
          selectedDistribution?.toLowerCase() === profile.wsl.distribution.toLowerCase();
        const directory = tokens.indexOf("--cd");
        const inlineDirectory = tokens.find(value => /^--cd=/i.test(value));
        const nativeCwd = directory >= 0 ? tokens[directory + 1] :
          inlineDirectory ? inlineDirectory.slice("--cd=".length) : dedicated ? profile!.wsl!.repoRoot : cwd;
        const executable = tokens.findIndex(value => /^(?:-e|--exec)$/i.test(value));
        const rest = executable >= 0 ? tokens.slice(executable + 1) :
          tokens.filter((_, i) => !(distribution >= 0 && (i === distribution || i === distribution + 1)) &&
            !(directory >= 0 && (i === directory || i === directory + 1)) &&
            !/^--(?:distribution|cd)=/i.test(tokens[i]));
        if (inspect([rest], nativeCwd || cwd, dedicated, depth + 1)) return true;
        continue;
      }
      if (/^(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?$/i.test(program)) {
        const option = tokens.findIndex(value => /^(?:-[a-z]*c|-command|-encodedcommand)$/i.test(value));
        if (option >= 0 && tokens[option + 1]) {
          const nested = /^-encodedcommand$/i.test(tokens[option])
            ? Buffer.from(tokens[option + 1], "base64").toString("utf16le") : tokens[option + 1];
          if (inspect(nested, cwd, protectedShell, depth + 1)) return true;
        } else if ((inside(cwd) || protectedShell) && tokens.some(value => scripts.test(value))) return true;
        continue;
      }
      if (/^(?:env|command|call)$/i.test(program)) {
        while (tokens[0]?.includes("=")) tokens.shift();
        if (inspect([tokens], cwd, protectedShell, depth + 1)) return true;
        continue;
      }
      const directory = tokens.findIndex(value => /^(?:--cwd|--prefix|-C)$/i.test(value));
      const inlineDirectory = tokens.find(value => /^--(?:cwd|prefix)=/i.test(value));
      const effectiveCwd = directory >= 0 && tokens[directory + 1] ? resolve(cwd, tokens[directory + 1]) :
        inlineDirectory ? resolve(cwd, inlineDirectory.slice(inlineDirectory.indexOf("=") + 1)) : cwd;
      if (!protectedShell && !inside(effectiveCwd)) continue;
      if (managers.test(program) || runners.test(program) || scripts.test(program)) return true;
      if (/^git(?:\.exe)?$/i.test(program) && tokens.includes("push")) return true;
      if (/^(?:node|python|python3)(?:\.exe)?$/i.test(program) &&
          tokens.some(value => scripts.test(value) || runners.test(toolName(value)) ||
            /(?:child_process|subprocess|execFile|spawnSync|execSync)/.test(value))) return true;
    }
    return false;
  }
  return inspect(command, initialCwd);
}
