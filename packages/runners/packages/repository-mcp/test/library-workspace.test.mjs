import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareLibraryWorkspace, preserveTrackedTsconfigs } from "../src/adapters/library-workspace.mjs";
import { execFileSync } from "node:child_process";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "library-workspace-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function fixture() {
  const root = fs.mkdtempSync(path.join(scratch, "case-"));
  const seed = path.join(root, "seed");
  const workspace = path.join(root, "workspace");
  const packageAt = (base, name) => {
    const directory = path.join(base, "midgard", "packages", name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: `@1js/${name}` }));
    return directory;
  };
  const dependency = packageAt(seed, "dependency");
  const library = packageAt(workspace, "library");
  const source = path.join(seed, "midgard", "node_modules", "@1js", "dependency");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.symlinkSync(dependency, source, process.platform === "win32" ? "junction" : "dir");
  const generator = path.join(seed, "midgard", ".scoper", "cache", ".workspaces",
    "@1js-midgard-project-references", "update-ts-config.js");
  fs.mkdirSync(path.dirname(generator), { recursive: true });
  fs.writeFileSync(generator, "exports.updateTsConfig = async () => {};\n");
  return { root, seed, workspace, dependency, library, packageAt, generator,
    destination: path.join(workspace, "midgard", "node_modules", "@1js", "dependency") };
}

test("scope expansion retargets only the exact existing seed dependency junction", async () => {
  const f = fixture();
  await prepareLibraryWorkspace(f.workspace, f.seed);
  expect(fs.realpathSync(f.destination)).toBe(f.dependency);
  const local = f.packageAt(f.workspace, "dependency");
  await prepareLibraryWorkspace(f.workspace, f.seed);
  expect(fs.realpathSync(f.destination)).toBe(local);
  await prepareLibraryWorkspace(f.workspace, f.seed);
  expect(fs.realpathSync(f.destination)).toBe(local);
  expect(fs.existsSync(f.dependency)).toBe(true);
});

test("scope expansion preserves and refuses an unrelated existing dependency junction", async () => {
  const f = fixture();
  const unknown = f.packageAt(f.root, "unknown");
  fs.mkdirSync(path.dirname(f.destination), { recursive: true });
  fs.symlinkSync(unknown, f.destination, process.platform === "win32" ? "junction" : "dir");
  f.packageAt(f.workspace, "dependency");
  await expect(prepareLibraryWorkspace(f.workspace, f.seed)).rejects.toThrow("Dependency points outside");
  expect(fs.realpathSync(f.destination)).toBe(unknown);
});

test("local dependency selection refuses a junction redirect instead of consuming external source", async () => {
  const f = fixture();
  const unknown = f.packageAt(f.root, "unknown");
  fs.symlinkSync(unknown, path.join(f.workspace, "midgard", "packages", "dependency"),
    process.platform === "win32" ? "junction" : "dir");
  await expect(prepareLibraryWorkspace(f.workspace, f.seed)).rejects.toThrow("Local dependency must not redirect");
  expect(fs.existsSync(f.destination)).toBe(false);
});

test.each([false, true])("metadata restores exact original config when the generator mutates it (throws: %s)", async throws => {
  const f = fixture();
  const source = f.packageAt(f.seed, "library");
  fs.mkdirSync(path.join(source, "node_modules"));
  const config = path.join(f.library, "tsconfig.json");
  const original = '{\r\n  "compilerOptions": { "strict": true }\r\n}\r\n';
  fs.writeFileSync(config, original);
  fs.writeFileSync(f.generator, `
    const fs = require("node:fs");
    const path = require("node:path");
    exports.updateTsConfig = async directory => {
      fs.writeFileSync(path.join(directory, "tsconfig.json"), "{}\\n");
      ${throws ? 'throw new Error("generator failure");' : ""}
    };
  `);
  await expect(prepareLibraryWorkspace(f.workspace, f.seed)).rejects.toThrow(
    throws ? "generator failure" : "original content restored");
  expect(fs.readFileSync(config, "utf8")).toBe(original);
});

test("explicit metadata scope keeps dependency wiring but only generates selected package metadata", async () => {
  const f = fixture();
  for (const name of ["library", "dependency"]) {
    const seed = f.packageAt(f.seed, name);
    fs.mkdirSync(path.join(seed, "node_modules"), { recursive: true });
    const local = f.packageAt(f.workspace, name);
    fs.writeFileSync(path.join(local, "tsconfig.json"), "{}\n");
  }
  fs.writeFileSync(f.generator, `
    const path = require("node:path");
    exports.updateTsConfig = async directory => {
      if (path.basename(directory) !== "library") throw new Error("Out-of-scope metadata");
    };
  `);
  await prepareLibraryWorkspace(f.workspace, f.seed, ["library"]);
  expect(fs.realpathSync(f.destination)).toBe(path.join(f.workspace, "midgard", "packages", "dependency"));
  await expect(prepareLibraryWorkspace(f.workspace, f.seed, ["absent"])).rejects.toThrow("checked-out");
});

test("installation preserves tracked TypeScript inputs while accepting only formatting and empty default conditions", async () => {
  const f = fixture();
  const config = path.join(f.library, "tsconfig.json");
  const original = '{"compilerOptions":{"strict":true}}\n';
  fs.writeFileSync(config, original);
  execFileSync("git", ["init", "-q"], { cwd: f.workspace });
  execFileSync("git", ["add", "."], { cwd: f.workspace });
  await preserveTrackedTsconfigs(f.workspace, async () => {
    fs.writeFileSync(config, '{\n "compilerOptions": {"strict":true,"customConditions":[]}\n}\n');
  });
  expect(fs.readFileSync(config, "utf8")).toBe(original);
  await expect(preserveTrackedTsconfigs(f.workspace, async () => {
    fs.writeFileSync(config, '{"compilerOptions":{"strict":false}}\n');
  })).rejects.toThrow("original content restored");
  expect(fs.readFileSync(config, "utf8")).toBe(original);
  await expect(preserveTrackedTsconfigs(f.workspace, async () => {
    fs.writeFileSync(config, "{}\n");
    throw new Error("actual installer failure");
  })).rejects.toThrow("actual installer failure");
  expect(fs.readFileSync(config, "utf8")).toBe(original);
});
