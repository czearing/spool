import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP_DIRECTORIES = [".git", "node_modules", "dist", "build", "out", "coverage",
  ".next", ".turbo", ".cache", "__snapshots__"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];
const TEST_MARKERS = [".test.", ".spec.", "/__tests__/", "/test/", "/tests/"];

export const toPosix = value => value.split(sep).join("/");

export function createTreeScanner({ partition, markdown = false, skipDirectories = [] }) {
  const skippedDirectories = new Set([...SKIP_DIRECTORIES, ...skipDirectories]);
  function kindOf(value) {
    const lowered = value.toLowerCase();
    if (markdown && lowered.endsWith(".md")) return "markdown";
    if (lowered.endsWith(".d.ts")) return null;
    if (SOURCE_EXTENSIONS.some(extension => lowered.endsWith(extension)) &&
        !TEST_MARKERS.some(marker => lowered.includes(marker))) return "source";
    return null;
  }
  function walk(root, directory, files) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) walk(root, full, files);
      } else if (entry.isFile()) {
        files.push(toPosix(relative(root, full)));
      }
    }
  }
  function scanTrees({ repoRoot, trees }) {
    const found = [];
    for (const tree of trees) {
      const absolute = join(repoRoot, tree.split("/").join(sep));
      let directory;
      try { directory = statSync(absolute).isDirectory(); }
      catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (directory) walk(repoRoot, absolute, found);
    }
    const { kept, skipped } = partition(found.filter(value => kindOf(value) !== null));
    return {
      ...(markdown ? { markdown: kept.filter(value => kindOf(value) === "markdown").sort() } : {}),
      source: kept.filter(value => kindOf(value) === "source").sort(),
      skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)),
    };
  }
  function inScope({ paths, trees }) {
    return partition(paths.filter(value =>
      trees.some(tree => value === tree || value.startsWith(`${tree}/`)) && kindOf(value) !== null));
  }
  return { kindOf, scanTrees, inScope };
}
