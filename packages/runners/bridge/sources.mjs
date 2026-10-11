import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const engineRoot = fileURLToPath(new URL("../scanners/", import.meta.url));
export const enginePath = (...parts) => path.join(engineRoot, ...parts);
export const engine = relative => import(pathToFileURL(enginePath(relative)));
export const profile = folder => JSON.parse(readFileSync(enginePath(folder, "config.json"), "utf8"));
export const engineProfile = folder => JSON.parse(readFileSync(enginePath(folder, "engine.config.json"), "utf8"));

export function assertCanonicalSources(directory = path.resolve(import.meta.dirname, "..")) {
  const resolver = createRequire(path.join(directory, "package.json"));
  const packages = realpathSync(path.join(directory, "packages")) + path.sep;
  for (const name of ["bohemia-agent-tooling", "bohemia-pr-mcp/client"]) {
    const actual = realpathSync(resolver.resolve(name));
    if (!actual.startsWith(packages)) throw new Error(`${name} resolves outside the canonical release: ${actual}`);
  }
  const scanners = realpathSync(path.join(directory, "scanners"));
  if (scanners !== path.join(realpathSync(directory), "scanners")) {
    throw new Error(`Scanner source resolves outside the canonical release: ${scanners}`);
  }
}
