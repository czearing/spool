import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";

function patchGroups(root) {
  const groups = new Map();
  const visit = directory => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const patches = entries.filter(entry => entry.isFile() && entry.name.endsWith(".patch"))
      .map(entry => entry.name).sort();
    if (patches.length) {
      const hash = createHash("sha256").update(path.relative(root, directory));
      for (const name of patches) hash.update("\0").update(name).update("\0")
        .update(fs.readFileSync(path.join(directory, name)));
      groups.set(`${hash.digest("hex")}.done`, patches.map(name => path.join(directory, name)));
    }
    for (const entry of entries) if (entry.isDirectory()) visit(path.join(directory, entry.name));
  };
  if (fs.existsSync(path.join(root, "patches"))) visit(path.join(root, "patches"));
  return groups;
}

function stockChecker(root) {
  const require = createRequire(path.join(root, "package.json"));
  const { parsePatchFile } = require("patch-package/dist/patch/parse");
  const { reversePatch } = require("patch-package/dist/patch/reverse");
  const { executeEffects } = require("patch-package/dist/patch/apply");
  return (directory, files, reverse) => {
    const patches = files.map(file => parsePatchFile(fs.readFileSync(file, "utf8")));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "1js-dependency-patch-check-"));
    try {
      const paths = new Set(patches.flat().flatMap(effect =>
        [effect.path, effect.fromPath, effect.toPath].filter(Boolean)));
      for (const relative of paths) {
        const source = path.resolve(directory, relative), target = path.resolve(temporary, relative);
        if (!source.startsWith(directory + path.sep) || !target.startsWith(temporary + path.sep))
          throw new Error("Stock dependency patch escapes its package");
        if (!fs.existsSync(source)) continue;
        const stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsupported patch target");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, (stat.mode & 0o777) | 0o600);
      }
      try {
        for (const patch of reverse ? [...patches].reverse() : patches)
          executeEffects(reverse ? reversePatch(patch) : patch,
            { dryRun: false, cwd: temporary, bestEffort: false });
        return true;
      } catch { return false; }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  };
}

export async function invalidateObsoleteDependencyPatches(profile, env, checkout) {
  const stock = path.join(profile.workspaceRoot, "packages", "patch-dependencies");
  const store = env.MYS_GLOBAL_STORE || path.join(profile.workspaceRoot, ".store");
  if (!fs.existsSync(store)) return [];
  const entries = fs.readdirSync(store, { withFileTypes: true }), obsolete = new Set();
  for (const [marker, patches] of patchGroups(stock)) {
    const parts = path.relative(path.join(stock, "patches"), path.dirname(patches[0])).split(path.sep);
    const name = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    for (const entry of entries.filter(entry => entry.name.startsWith(`${name.replace("/", "-")}@`))) {
      const location = path.join(store, entry.name);
      if (!entry.isDirectory()) throw new Error("Dependency store entries must be real generated directories");
      const file = path.join(location, "node_modules", name, "package.json");
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      if (manifest.name !== name) continue;
      const versioned = path.join(stock, "patches", name, manifest.version);
      const directory = fs.existsSync(versioned) ? versioned : path.join(stock, "patches", name);
      if (directory !== path.dirname(patches[0])) continue;
      const markers = path.join(location, ".patch-dependencies");
      if (!fs.existsSync(markers) || fs.existsSync(path.join(markers, marker))) continue;
      if (!fs.lstatSync(markers).isDirectory() || fs.lstatSync(markers).isSymbolicLink())
        throw new Error("Dependency patch cache must not redirect outside its installed package");
      if (!fs.readdirSync(markers).some(name => /^[a-f0-9]{64}\.done$/.test(name))) continue;
      const physical = fs.realpathSync(location);
      if (![profile.workspaceRoot, profile.stateRoot].filter(Boolean).some(root =>
        physical.startsWith(fs.realpathSync(root) + path.sep)) ||
          fs.realpathSync(store) !== path.dirname(physical) ||
          await checkout.git("ls-files", "--", path.relative(profile.repoRoot || profile.workspaceRoot, physical)))
        throw new Error("Obsolete dependency patches require an untracked checkout-private store entry");
      obsolete.add(physical);
    }
  }
  for (const location of obsolete) fs.rmSync(location, { recursive: true, force: true });
  return [...obsolete];
}

export function validateDependencyPatchCache(profile, packages, env, repair = false, checker) {
  const stock = path.join(profile.workspaceRoot, "packages", "patch-dependencies");
  const groups = patchGroups(stock);
  if (!groups.size) return [];
  const checkPatch = checker || stockChecker(stock);
  let store = env.MYS_GLOBAL_STORE;
  if (!store) {
    let directory = profile.workspaceRoot;
    while (true) {
      const candidate = path.join(directory, ".store");
      if (fs.existsSync(candidate)) { store = candidate; break; }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const locations = new Set();
  if (store && fs.existsSync(store)) {
    for (const entry of fs.readdirSync(store, { withFileTypes: true }))
      if (entry.isDirectory()) locations.add(path.join(store, entry.name));
  } else [profile.workspaceRoot, ...packages.map(pkg => pkg.root)].forEach(location => locations.add(location));
  const stale = [], unapplied = new Set();
  for (const location of locations) {
    const directory = path.join(location, ".patch-dependencies");
    if (!fs.existsSync(directory)) continue;
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())
      throw new Error("Dependency patch cache must not redirect outside its installed package");
    for (const name of fs.readdirSync(directory)) {
      const patches = groups.get(name);
      if (!patches) continue;
      const marker = path.join(directory, name);
      if (!fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink())
        throw new Error("Unsafe generated dependency patch marker");
      if (checkPatch(location, patches, true)) continue;
      if (!checkPatch(location, patches, false))
        throw new Error(`Installed dependency differs from both sides of stock patch: ${patches.map(patch => path.basename(patch)).join(", ")}`);
      patches.forEach(patch => unapplied.add(path.basename(patch)));
      stale.push(marker);
    }
  }
  if (stale.length && !repair) {
    const error = new Error(`Stock dependency patches were not applied: ${[...unapplied].join(", ")}`);
    error.staleMarkers = stale;
    throw error;
  }
  for (const marker of stale) fs.unlinkSync(marker);
  return stale;
}
