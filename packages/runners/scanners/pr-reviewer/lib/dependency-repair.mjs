import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function needsDependencyRepair(error) {
  return typeof error === "string" && /MODULE_NOT_FOUND|cannot (?:find|resolve) (?:module|package)|missing dependenc|stale (?:build|artifact)|buildWarmed:\s*false|(?:missing|absent|stale|matching).{0,100}(?:declarations?|generated|build.output)|(?:generated|declarations?).{0,100}(?:missing|absent|stale)|(?:declaration|build|generated)[ -]output (?:preparation|repair)/i.test(error);
}
export function reviewBuildPackages(repoRoot) {
  const files = execFileSync("git", ["diff", "--name-only", "-z", "origin/master...HEAD"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 30000 }).split("\0").filter(Boolean);
  const root = path.resolve(repoRoot), packages = new Set();
  for (const file of files) {
    let directory = path.dirname(path.resolve(root, file));
    while (directory !== root && directory.startsWith(root + path.sep)) {
      const manifest = path.join(directory, "package.json");
      if (existsSync(manifest)) {
        const { name } = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof name !== "string" || !/^[a-zA-Z0-9@/._-]+$/.test(name) || name.startsWith("-"))
          throw new Error(`Invalid changed package identity: ${manifest}`);
        packages.add(name); break;
      }
      directory = path.dirname(directory);
    }
  }
  if (!packages.size) throw new Error("Dependency repair requires an identifiable changed package; review continuation held.");
  return [...packages].sort();
}
