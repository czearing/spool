import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimePaths = ["bridge", "scanners", "packages", "package.json", "node_modules"];
const include = file => !file.split(path.sep).some(part =>
  ["test", "tests", "test-runtime", ".runner", ".runner-receipts", ".git", ".pnpm", ".bin", "logs"].includes(part)) &&
  !/\.(?:test|spec)\.[cm]?[jt]s$/.test(file) && !file.endsWith("pnpm-lock.yaml") &&
  !path.basename(file).startsWith(".env") && !file.endsWith(path.join("packages", "workflow"));

export async function verifyRunners(root) {
  for (const relative of ["src/index.mjs", "src/worker.mjs", "src/errors.mjs",
    "src/codespaces/application.mjs", "src/codespaces/application-browser.mjs", "src/codespaces/application-vm.mjs",
    "src/codespaces/application-auth-source.mjs", "src/codespaces/application-broker.mjs",
    "src/codespaces/deployed-browser.mjs", "src/codespaces/deployed-sign-in.mjs", "src/codespaces/deployed-vm.mjs",
    "src/codespaces/copilot.mjs", "src/codespaces/figma-fetch.mjs",
    "src/codespaces/creator-review.mjs",
    "src/codespaces/connector/src/connect.ts", "src/codespaces/connector/src/agentsAuth.ts"]) {
    const file = path.join(root, "packages", "repository-mcp", relative);
    try { await stat(file); }
    catch { throw new Error(`Incomplete repository MCP bundle: ${relative}. Package the complete repository-mcp directory.`); }
  }
  const files = {};
  async function verify(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file);
      if (!include(relative) || entry.name === "node_modules") continue;
      if (entry.isDirectory()) { await verify(file); continue; }
      const data = await readFile(file);
      files[relative.split(path.sep).join("/")] = createHash("sha256").update(data).digest("hex");
      if (!/\.(?:mjs|js|ts|ps1)$/.test(file)) continue;
      const text = data.toString("utf8");
      const references = file.endsWith(".ps1")
        ? /\bJoin-Path\s+\$PSScriptRoot\s+["']([^"'$]+\.(?:mjs|cjs|js|ts|ps1))["']/g
        : /\b(?:from\s*|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g;
      for (const match of text.matchAll(references)) {
        const resolved = path.resolve(path.dirname(file), match[1]);
        try { await stat(resolved); }
        catch { throw new Error(`Missing runner module: ${relative} -> ${match[1]}`); }
      }
      for (const match of text.matchAll(/new URL\(["'](\.[^"']+\.(?:mjs|cjs|js|ts|ps1))["'],\s*import\.meta\.url/g))
        await stat(path.resolve(path.dirname(file), match[1]));
    }
  }
  for (const name of runtimePaths.filter(name => name !== "node_modules")) {
    if (name === "package.json") files[name] = createHash("sha256").update(await readFile(path.join(root, name))).digest("hex");
    else await verify(path.join(root, name));
  }
  await import(pathToFileURL(path.join(root, "packages", "repository-mcp", "src", "codespaces", "copilot.mjs")).href);
  return files;
}

export async function buildRunners({
  source = path.resolve(import.meta.dirname, "../../../packages/runners"),
  target = path.resolve(import.meta.dirname, "../src-tauri/resources/runners"),
} = {}) {
  await stat(path.join(source, "node_modules", "harper.js"));
  const expected = await verifyRunners(source);
  await mkdir(path.dirname(target), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(target), ".runners-stage-"));
  const previous = `${target}-previous-${randomUUID()}`;
  let saved = false;
  try {
    for (const name of runtimePaths) {
      await cp(path.join(source, name), path.join(staging, name), {
        recursive: true, dereference: true, filter: file => include(path.relative(source, file)),
      });
    }
    const actual = await verifyRunners(staging);
    for (const [problem, files] of [
      ["Packaged runner content differs from source", actual],
      ["Runner sources changed during packaging", await verifyRunners(source)],
    ]) {
      const changed = [...new Set([...Object.keys(expected), ...Object.keys(files)])]
        .filter(file => files[file] !== expected[file]);
      if (changed.length)
        throw new Error(`${problem}: ${changed.join(", ")}. The previous bundle was preserved.`);
    }
    await import(pathToFileURL(path.join(staging, "bridge", "run.mjs")).href);
    await writeFile(path.join(staging, "runtime-manifest.json"), JSON.stringify({ version: 1, files: actual }, null, 2));
    try { await rename(target, previous); saved = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    try { await rename(staging, target); }
    catch (error) { if (saved) { await rename(previous, target); saved = false; } throw error; }
    if (saved) await rm(previous, { recursive: true, force: true });
    console.log("Packaged and verified one complete application-owned runner runtime.");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
