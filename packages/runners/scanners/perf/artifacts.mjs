import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import path from "node:path";

export const measurementVersion = "production-client-artifacts-v1";
export const appPath = path.join("apps", "new-office");
export const digest = value => createHash("sha256").update(value).digest("hex");

function assetPath(root, name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes(":") ||
      name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`Invalid emitted asset path: ${name}`);
  }
  const file = realpathSync(path.join(root, ...name.split("/")));
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Asset escapes client output: ${name}`);
  return file;
}

export function summarizeAssets(names, byName) {
  const assets = [...new Set(names)].sort().map(name => {
    const asset = byName.get(name);
    if (!asset) throw new Error(`Build group references an unmeasured asset: ${name}`);
    return asset;
  });
  const missing = assets.filter(asset => asset.brotliBytes === null).map(asset => asset.name);
  return {
    identityBytes: assets.reduce((sum, asset) => sum + asset.identityBytes, 0),
    brotliBytes: missing.length ? null : assets.reduce((sum, asset) => sum + asset.brotliBytes, 0),
    missingBrotli: missing,
    assets: assets.map(asset => asset.name),
  };
}

export function readArtifacts(repoRoot, { includeExcluded = false } = {}) {
  const app = path.join(repoRoot, appPath);
  const root = realpathSync(path.join(app, "dist", "client"));
  const analysis = path.join(app, "bundleAnalysis", "client");
  const statsBytes = readFileSync(path.join(analysis, "bundleStats.json"));
  const configBytes = readFileSync(path.join(analysis, "bundleBuddyConfig.json"));
  const stats = JSON.parse(statsBytes);
  const config = JSON.parse(configBytes);
  if (!Array.isArray(stats.assets) || !Array.isArray(stats.loopCustomStats?.assetGroups)) {
    throw new Error("Production client stats must contain assets and route asset groups");
  }
  if (!Array.isArray(config.chunksToExcludeFromTotal) || config.chunksToExcludeFromTotal.some(value => typeof value !== "string")) {
    throw new Error("Bundle Buddy must declare its asset exclusion policy");
  }
  const exclusions = config.chunksToExcludeFromTotal.map(pattern => new RegExp(pattern));
  const excluded = name => exclusions.some(pattern => pattern.test(name));
  const assets = [], excludedAssets = [], seen = new Set();
  for (const item of stats.assets) {
    if (typeof item.name !== "string" || !/\.(?:js|mjs|css)$/.test(item.name)) continue;
    if (seen.has(item.name)) throw new Error(`Duplicate emitted asset: ${item.name}`);
    seen.add(item.name);
    if (excluded(item.name)) {
      excludedAssets.push(item.name);
      if (!includeExcluded) continue;
    }
    const file = assetPath(root, item.name);
    const contents = readFileSync(file);
    if (!Number.isSafeInteger(item.size) || item.size !== contents.length) {
      throw new Error(`Emitted asset size does not match build stats: ${item.name}`);
    }
    const sidecarName = path.posix.join(path.posix.dirname(item.name), `br.${path.posix.basename(item.name)}`);
    let compressed = null;
    if (existsSync(path.join(root, ...sidecarName.split("/")))) {
      compressed = readFileSync(assetPath(root, sidecarName));
      const decoded = brotliDecompressSync(compressed, { maxOutputLength: contents.length + 1 });
      if (!decoded.equals(contents)) throw new Error(`Brotli sidecar does not match its emitted asset: ${item.name}`);
    }
    assets.push({ name: item.name, identityBytes: contents.length,
      brotliBytes: compressed?.length ?? null, sha256: digest(contents),
      brotliSha256: compressed ? digest(compressed) : null });
  }
  if (!assets.length) throw new Error("Production build contains no measurable client JS/CSS assets");
  assets.sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(assets.map(asset => [asset.name, asset]));
  const groups = [], groupNames = new Set();
  for (const group of stats.loopCustomStats.assetGroups) {
    if (typeof group.name !== "string" || !group.name.startsWith("route:") ||
        !Array.isArray(group.assets) || group.assets.some(name => typeof name !== "string")) {
      throw new Error("Malformed production route asset group");
    }
    if (groupNames.has(group.name)) throw new Error(`Duplicate route asset group: ${group.name}`);
    groupNames.add(group.name);
    const names = group.assets.filter(name => includeExcluded || !excluded(name));
    if (!names.length) throw new Error(`Route asset group is empty: ${group.name}`);
    groups.push({ name: group.name, label: group.metricDisplayName || group.name, ...summarizeAssets(names, byName) });
  }
  if (!groupNames.has("route:__root__")) throw new Error("Production client stats are missing the root entrypoint group");
  const evidence = { statsSha256: digest(statsBytes), analysisConfigSha256: digest(configBytes), assets, groups };
  return {
    measurementVersion, fingerprint: digest(JSON.stringify(evidence)), ...evidence,
    totals: summarizeAssets(assets.map(asset => asset.name), byName),
    excludedAssets: excludedAssets.sort(), exclusions: config.chunksToExcludeFromTotal,
  };
}
