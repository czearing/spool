import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { invalidateObsoleteDependencyPatches,
  validateDependencyPatchCache as validateCache } from "../src/adapters/1js-patch-cache.mjs";

function validateDependencyPatchCache(profile, packages, env, repair) {
  return validateCache(profile, packages, env, repair, (cwd, files, reverse) => {
    assert.equal(files.length, 1);
    const result = spawnSync("git", ["apply", "--check", ...(reverse ? ["--reverse"] : []), files[0]],
      { cwd, env, encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    assert.ok([0, 1].includes(result.status), result.stderr);
    return result.status === 0;
  });
}

function fixture(content, suppliedPatches) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "1js-patch-cache-"));
  const stock = path.join(root, "packages", "patch-dependencies");
  const directory = path.join(stock, "patches", "sample", "1.0.0");
  const location = path.join(root, ".store", "sample@1.0.0");
  const target = path.join(location, "node_modules", "sample", "index.js");
  const name = "sample+1.0.0.patch";
  const patch = "diff --git a/node_modules/sample/index.js b/node_modules/sample/index.js\n" +
    "--- a/node_modules/sample/index.js\n+++ b/node_modules/sample/index.js\n@@ -1 +1 @@\n-old\n+new\n";
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const patches = suppliedPatches || { [name]: patch };
  for (const [file, contents] of Object.entries(patches))
    fs.writeFileSync(path.join(directory, file), contents);
  fs.writeFileSync(target, content);
  const hash = createHash("sha256").update(path.relative(stock, directory));
  for (const name of Object.keys(patches).sort())
    hash.update("\0").update(name).update("\0").update(patches[name]);
  const marker = path.join(location, ".patch-dependencies", `${hash.digest("hex")}.done`);
  fs.mkdirSync(path.dirname(marker));
  fs.writeFileSync(marker, "");
  return { root, stock, marker, target, profile: { workspaceRoot: root },
    dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("only proven-unpatched generated stock markers are invalidated; dependency files and unrelated receipts are untouched", () => {
  const f = fixture("old\n");
  try {
    const unrelated = path.join(path.dirname(f.marker), "unrelated.done");
    fs.writeFileSync(unrelated, "");
    assert.deepEqual(validateDependencyPatchCache(f.profile, [], process.env, true), [f.marker]);
    assert.equal(fs.existsSync(f.marker), false);
    assert.equal(fs.existsSync(unrelated), true);
    assert.equal(fs.readFileSync(f.target, "utf8"), "old\n");
  } finally { f.dispose(); }
});

test("actual applied patch contents preserve generated markers regardless of stamp age", () => {
  const f = fixture("new\n");
  try {
    fs.utimesSync(f.marker, new Date(0), new Date(0));
    assert.deepEqual(validateDependencyPatchCache(f.profile, [], process.env, true), []);
    assert.equal(fs.existsSync(f.marker), true);
  } finally { f.dispose(); }
});

test("setup discards only installed packages carrying another revision's stock patch marker", async () => {
  for (const changed of [false, true]) {
    const f = fixture("previous revision's patched contents\n");
    try {
      const location = path.dirname(path.dirname(f.marker));
      fs.writeFileSync(path.join(path.dirname(f.target), "package.json"),
        JSON.stringify({ name: "sample", version: "1.0.0" }));
      if (changed) fs.renameSync(f.marker, path.join(path.dirname(f.marker), `${"f".repeat(64)}.done`));
      const unrelated = path.join(f.root, ".store", "unrelated@1.0.0");
      fs.mkdirSync(unrelated);
      const removed = await invalidateObsoleteDependencyPatches(f.profile, {}, {
        git: async (...args) => { assert.equal(args[0], "ls-files"); return ""; },
      });
      assert.deepEqual(removed, changed ? [fs.realpathSync(path.dirname(unrelated)) + path.sep + path.basename(location)] : []);
      assert.equal(fs.existsSync(location), !changed);
      assert.equal(fs.existsSync(unrelated), true);
    } finally { f.dispose(); }
  }
});

test("setup refuses to discard tracked dependency-store contents", async () => {
  const f = fixture("old branch patch\n");
  try {
    fs.writeFileSync(path.join(path.dirname(f.target), "package.json"),
      JSON.stringify({ name: "sample", version: "1.0.0" }));
    fs.renameSync(f.marker, path.join(path.dirname(f.marker), `${"f".repeat(64)}.done`));
    await assert.rejects(invalidateObsoleteDependencyPatches(f.profile, {}, {
      git: async () => ".store/sample@1.0.0/source.js",
    }), /untracked checkout-private/);
    assert.equal(fs.readFileSync(f.target, "utf8"), "old branch patch\n");
  } finally { f.dispose(); }
});

test("unexpected installed contents fail closed without invalidating caches or editing dependencies", () => {
  const f = fixture("unexpected\n");
  try {
    assert.throws(() => validateDependencyPatchCache(f.profile, [], process.env, true), /both sides/);
    assert.equal(fs.existsSync(f.marker), true);
    assert.equal(fs.readFileSync(f.target, "utf8"), "unexpected\n");
  } finally { f.dispose(); }
});

test("post-install verification refuses a stale marker instead of reporting setup ready", () => {
  const f = fixture("old\n");
  try {
    assert.throws(() => validateDependencyPatchCache(f.profile, [], process.env), /not applied/);
    assert.equal(fs.existsSync(f.marker), true);
  } finally { f.dispose(); }
});

test("stock-engine verification reverses sequential patches only in writable private copies", () => {
  const operation = (before, after) => JSON.stringify([{ path: "node_modules/sample/index.js", before, after }]);
  for (const content of ["old\n", "new\n"]) {
    const f = fixture(content, { "sample+001.patch": operation("old\n", "middle\n"),
      "sample+002.patch": operation("middle\n", "new\n") });
    try {
      const engine = path.join(f.stock, "node_modules", "patch-package", "dist", "patch");
      fs.mkdirSync(engine, { recursive: true });
      fs.writeFileSync(path.join(engine, "parse.js"), "exports.parsePatchFile = JSON.parse;");
      fs.writeFileSync(path.join(engine, "reverse.js"),
        "exports.reversePatch = effects => effects.map(e => ({...e, before:e.after, after:e.before}));");
      fs.writeFileSync(path.join(engine, "apply.js"),
        "const f=require('node:fs'),p=require('node:path');exports.executeEffects=(effects,{cwd})=>{" +
        "for(const e of effects){const t=p.join(cwd,e.path);if(f.readFileSync(t,'utf8')!==e.before)" +
        "throw Error('Patch mismatch');f.writeFileSync(t,e.after);}};");
      fs.chmodSync(f.target, 0o400);
      const mode = fs.statSync(f.target).mode;
      assert.deepEqual(validateCache(f.profile, [], process.env, true),
        content === "old\n" ? [f.marker] : []);
      assert.equal(fs.readFileSync(f.target, "utf8"), content);
      assert.equal(fs.statSync(f.target).mode, mode);
    } finally { f.dispose(); }
  }
});
