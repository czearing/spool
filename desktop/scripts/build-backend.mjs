import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { routeSource } from "../backend/route-source.ts";
import { buildRunners } from "./build-runners.mjs";

const root = path.resolve(import.meta.dirname, "..");
const target = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
if (!target) throw new Error("Rust host target unavailable.");
const executable = process.platform === "win32" ? "spool.exe" : "spool";
const cargoTarget = path.join(root, "..", "target");
execFileSync("cargo", ["build", "--locked", "--release", "--bin", "spool",
  "--manifest-path", path.join(root, "..", "Cargo.toml"), "--target", target,
  "--target-dir", cargoTarget], { stdio: "inherit" });
await mkdir(path.join(root, "src-tauri", "resources", "native"), { recursive: true });
await copyFile(path.join(cargoTarget, target, "release", executable),
  path.join(root, "src-tauri", "resources", "native", executable));
await buildRunners();
await mkdir(path.join(root, "src-tauri", "resources"), { recursive: true });
await build({
  entryPoints: [path.join(root, "backend", "main.ts")], bundle: true, platform: "node", format: "esm",
  target: "node24", outfile: path.join(root, "src-tauri", "resources", "backend.mjs"),
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  plugins: [{ name: "api-routes", setup(builder) {
    builder.onResolve({ filter: /^desktop:routes$/ }, () => ({ path: "routes", namespace: "desktop" }));
    builder.onLoad({ filter: /.*/, namespace: "desktop" }, async () => ({ contents: await routeSource(), loader: "ts", resolveDir: root }));
  } }],
});
await mkdir(path.join(root, "src-tauri", "binaries"), { recursive: true });
await copyFile(process.execPath, path.join(root, "src-tauri", "binaries", `spool-runtime-${target}${process.platform === "win32" ? ".exe" : ""}`));
console.log(`Prepared self-contained desktop runtime for ${target}.`);
