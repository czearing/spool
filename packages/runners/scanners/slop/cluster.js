/**
 * Groups and clusters individual files with slop into cohesive, module/folder-scoped task units.
 * Prevents wasting agent cycles on one-off 1-line PRs by condensing work in similar folders into single tasks.
 */

import { dirname } from "node:path";
import { reproductionCommand } from "./metrics.js";
import { slugifyBranchTopic } from "../../packages/bohemia-agent-tooling/src/index.js";

export function getFolderPath(relPath) {
  const dir = dirname(relPath).replace(/\\/g, "/");
  return dir === "." ? "" : dir;
}

/**
 * Finds the nearest meaningful feature/module directory for a relative path.
 */
export function getFeatureDirectory(relPath) {
  const parts = String(relPath).replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length >= 2 && (parts[0] === "apps" || parts[0] === "packages")) {
    return `${parts[0]}/${parts[1]}`;
  }

  return parts.slice(0, Math.min(2, parts.length - 1)).join("/") || parts[0] || ".";
}

/**
 * Clusters measured files into cohesive task sets by folder/feature structure.
 */
export function clusterFiles(filesMeasured, { maxFilesPerCluster = 50, activeTasks = [] } = {}) {
  if (!filesMeasured || filesMeasured.length === 0) return [];

  const activeIdentifiers = new Set();
  for (const t of activeTasks) {
    if (!t.title) continue;
    activeIdentifiers.add(t.title);
    const match = t.title.match(/slop:\s+([^\s(]+)/) || t.title.match(/comments in\s+([^\s(]+)/);
    if (match) activeIdentifiers.add(match[1]);
  }

  // 1. Initial bucket by feature directory
  const buckets = new Map();

  for (const file of filesMeasured) {
    const featureDir = getFeatureDirectory(file.path);
    if (!buckets.has(featureDir)) {
      buckets.set(featureDir, []);
    }
    buckets.get(featureDir).push(file);
  }

  // 2. Build cluster objects
  const clusters = [];

  for (const [dir, files] of buckets.entries()) {
    const chunks = [];
    for (let i = 0; i < files.length; i += maxFilesPerCluster) {
      chunks.push(files.slice(i, i + maxFilesPerCluster));
    }

    for (const [idx, chunkFiles] of chunks.entries()) {
      const filePaths = chunkFiles.map((f) => f.path);
      const totalSlopLines = chunkFiles.reduce((acc, f) => acc + (f.totalSlopLines ?? f.slopLines ?? 0), 0);
      const totalSlopComments = chunkFiles.reduce((acc, f) => acc + (f.totalSlopComments ?? f.slopComments ?? 0), 0);
      const totalCodeLines = chunkFiles.reduce((acc, f) => acc + (f.totalCodeLines ?? f.codeLines ?? 0), 0);
      const slopDensity = totalCodeLines > 0 ? Number((totalSlopLines / totalCodeLines).toFixed(4)) : 0;

      const chunkSuffix = chunks.length > 1 ? ` (Part ${idx + 1})` : "";
      const slugSuffix = chunks.length > 1 ? `-part-${idx + 1}` : "";
      const commonDir = dir || "codebase";
      const slug = slugifyBranchTopic(`${commonDir.replace(/\.[a-zA-Z0-9]+$/, "").replace(/\//g, "-")}${slugSuffix}`);
      const title = `docs(comments): clean up redundant and verbose comments in ${commonDir}${chunkSuffix}`;

      const allFindings = [];
      for (const f of chunkFiles) {
        for (const item of f.findings || []) {
          allFindings.push({
            filePath: f.path,
            ...item,
          });
        }
      }

      const isInFlight =
        activeIdentifiers.has(dir) ||
        activeIdentifiers.has(commonDir) ||
        filePaths.some((p) => activeIdentifiers.has(p)) ||
        Array.from(activeIdentifiers).some((id) => id.includes(dir) || filePaths.some((p) => id.includes(p)));

      clusters.push({
        clusterId: `${commonDir}${chunkSuffix}`,
        directory: dir,
        title,
        branchTopic: `docs-${slug}`,
        branchName: `user/calebzearing/docs-${slug}`,
        fileCount: chunkFiles.length,
        files: filePaths,
        fileDetails: chunkFiles,
        totalSlopLines,
        totalSlopComments,
        totalCodeLines,
        slopDensity,
        reproduction: reproductionCommand(filePaths),
        findings: allFindings,
        isInFlight,
      });
    }
  }

  // Sort clusters by highest total slop lines first, then density
  clusters.sort((a, b) => b.totalSlopLines - a.totalSlopLines || b.slopDensity - a.slopDensity || a.clusterId.localeCompare(b.clusterId));

  return clusters;
}
