import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export async function buildRunners() {
  const source = path.resolve(import.meta.dirname, "../../packages/runners");
  const target = path.resolve(import.meta.dirname, "../src-tauri/resources/runners");
  await stat(path.join(source, "node_modules", "harper.js"));
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const include = file => !file.split(path.sep).some(part => ["test", "tests", "test-runtime", ".runner", ".git", ".pnpm", ".bin"].includes(part)) &&
    !/\.(?:test|spec)\.[cm]?[jt]s$/.test(file) && !file.endsWith("pnpm-lock.yaml");
  for (const name of ["bridge", "scanners", "packages", "package.json", "node_modules"]) {
    await cp(path.join(source, name), path.join(target, name), {
      recursive: true, dereference: true,
      filter: file => include(path.relative(source, file)) && !file.endsWith(path.join("packages", "workflow")),
    });
  }
  async function verify(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") await verify(file); continue; }
      if (!/\.(?:mjs|js|ts)$/.test(file)) continue;
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/(?:from\s*|import\()["'](\.[^"']+)["']/g)) {
        const resolved = path.resolve(path.dirname(file), match[1]);
        try { await stat(resolved); } catch { throw new Error(`Missing runner module: ${path.relative(target, file)} -> ${match[1]}`); }
      }
      for (const match of text.matchAll(/new URL\(["'](\.[^"']+\.(?:mjs|cjs|js|ts|ps1))["'],\s*import\.meta\.url/g))
        await stat(path.resolve(path.dirname(file), match[1]));
    }
  }
  await verify(target);
  console.log("Packaged application-owned runners and production dependencies.");
}
