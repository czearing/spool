import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { assertReviewCoverage } from "../codespaces/config.mjs";

export const packageIdentity = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function packageNames(values) {
  if (!Array.isArray(values) || !values.length || values.some(value =>
    typeof value !== "string" || !packageIdentity.test(value)))
    throw new Error("packages must contain explicit 1JS package names");
  return [...new Set(values)];
}

export function checkedOutPackage(root, directory) {
  const physical = fs.realpathSync(path.join(root, directory));
  if (physical !== path.join(fs.realpathSync(root), directory))
    throw new Error(`Package source redirects outside the checkout: ${directory}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(physical, "package.json"), "utf8"));
  if (!packageIdentity.test(manifest.name || "")) throw new Error(`Invalid package identity: ${directory}`);
  return { name: manifest.name, directory, root: physical, manifest };
}

export async function selectedPackages(checkout, profile, input = {}, files) {
  const directories = new Set(), requested = input.packages && packageNames(input.packages);
  if (requested) {
    const candidates = (await checkout.git("ls-files", "-z", "--", ":(glob)**/package.json"))
      .split("\0").filter(Boolean).map(file => path.posix.dirname(file));
    for (const directory of candidates) {
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(profile.repoRoot, directory, "package.json"), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (requested.some(name => name === manifest.name || name === path.posix.basename(directory)))
        directories.add(directory);
    }
  } else {
    const changed = files || [...new Set([
      ...await checkout.changedFiles(`refs/remotes/origin/${input.targetBranch || profile.baseBranch}`),
      ...(await checkout.git("diff", "--no-renames", "--name-only", "-z", "HEAD")).split("\0").filter(Boolean),
      ...(await checkout.git("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean),
    ])];
    assertReviewCoverage(changed);
    for (const file of changed) {
      if (/^midgard\/change\/[^/]+\.json$/.test(file)) {
        const change = JSON.parse(fs.readFileSync(path.join(profile.repoRoot, file), "utf8"));
        const owners = packageNames(change.changes?.map(entry => entry.packageName));
        for (const pkg of await selectedPackages(checkout, profile, { packages: owners })) directories.add(pkg.directory);
        continue;
      }
      let directory = path.posix.dirname(file);
      while (directory !== "." && !fs.existsSync(path.join(profile.repoRoot, directory, "package.json")))
        directory = path.posix.dirname(directory);
      if (directory === "." || directory === "midgard")
        throw new Error(`Root/infrastructure changes require explicit scoped packages: ${file}`);
      directories.add(directory);
    }
  }
  const packages = [...directories].map(directory => checkedOutPackage(profile.repoRoot, directory));
  if (!packages.length || requested && (packages.length !== requested.length ||
      requested.some(name => !packages.some(pkg => pkg.name === name || path.posix.basename(pkg.directory) === name))))
    throw new Error("Selected packages must uniquely identify existing checked-out 1JS packages");
  const byName = new Map(packages.map(pkg => [pkg.name, pkg])), ordered = [], visiting = new Set(), visited = new Set();
  const visit = pkg => {
    if (visited.has(pkg.name) || visiting.has(pkg.name)) return;
    visiting.add(pkg.name);
    for (const name of Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies }))
      if (byName.has(name)) visit(byName.get(name));
    visiting.delete(pkg.name);
    visited.add(pkg.name);
    ordered.push(pkg);
  };
  packages.forEach(visit);
  return ordered;
}

export async function scopedCommands(packages, operation, invoke) {
  const steps = [];
  for (const pkg of packages) {
    const scripts = pkg.manifest.scripts || {};
    const names = operation === "check" ? ["build", "bundle", "lint", "typecheck", "test"] : [operation];
    for (const name of names) {
      if (scripts[name]) {
        const args = [name];
        if (name === "test" && /(?:^|\s)vitest(?:\s|$)/.test(scripts.test)) args.push("--run");
        else if (name === "test" && /(?:^|\s)jest(?:\s|$)/.test(scripts.test)) args.push("--runInBand");
        steps.push(await invoke("yarn", args, pkg.root, `${pkg.name}:${name}`));
      } else if ((operation === "check" || operation === "typecheck") && name === "typecheck" &&
          fs.existsSync(path.join(pkg.root, "tsconfig.typecheck.json"))) {
        const require = createRequire(path.join(pkg.root, "package.json"));
        steps.push(await invoke("node", [require.resolve("typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.typecheck.json"],
          pkg.root, `${pkg.name}:typecheck`));
      } else if ((operation === "check" || operation === "test") && name === "test" &&
          fs.existsSync(path.join(pkg.root, "jest.config.cjs"))) {
        const require = createRequire(path.join(pkg.root, "package.json"));
        steps.push(await invoke("node", [require.resolve("jest/bin/jest"), "--config", "jest.config.cjs", "--runInBand"],
          pkg.root, `${pkg.name}:test`));
      } else if (operation !== "check" && operation !== "test") throw new Error(`${pkg.name} has no package-local ${name} command`);
    }
    if (operation === "check" && !steps.some(step => step.name.startsWith(`${pkg.name}:`)))
      throw new Error(`${pkg.name} has no supported package-local validation command`);
  }
  return steps;
}

export async function scopedValidationChecks(packages, profile, invoke) {
  const workspaces = new Set();
  for (const pkg of packages) {
    let workspace = path.dirname(pkg.root);
    while (workspace !== profile.repoRoot) {
      const file = path.join(workspace, "package.json");
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).scripts?.lage) break;
      const parent = path.dirname(workspace);
      if (parent === workspace) throw new Error(`No repository-owned scoped build for ${pkg.name}`);
      workspace = parent;
    }
    if (workspace === profile.repoRoot)
      throw new Error(`No repository-owned scoped build for ${pkg.name}; validation refused`);
    if (!["build", "bundle", "lint", "typecheck", "test"].some(name => pkg.manifest.scripts?.[name]) &&
        !["tsconfig.typecheck.json", "jest.config.cjs"].some(file => fs.existsSync(path.join(pkg.root, file))))
      throw new Error(`${pkg.name} has no supported package-local validation command`);
    workspaces.add(workspace);
  }
  const steps = [];
  for (const workspace of workspaces) {
    const selected = packages.filter(pkg => pkg.root.startsWith(workspace + path.sep));
    steps.push(await invoke("yarn", ["lage", "build", "bundle", "lint", "typecheck",
      "--scope", ...selected.map(pkg => pkg.name).sort(), "--no-deps", "--verbose", "--profile"],
      workspace, `${path.relative(profile.repoRoot, workspace).split(path.sep).join("/")}:scoped-check`));
    for (const pkg of selected)
      if (!pkg.manifest.scripts?.typecheck && fs.existsSync(path.join(pkg.root, "tsconfig.typecheck.json")))
        steps.push(...await scopedCommands([pkg], "typecheck", invoke));
    steps.push(...await scopedCommands(selected, "test", invoke));
  }
  return steps;
}

// Keep in-flight adapters compatible while the helpers are promoted.
export function affectedPublicationChecks(packages, profile, _checkout, _target, invoke) {
  return scopedValidationChecks(packages, profile, invoke);
}

export async function publicationChangeAllowed(file, checkout, packages) {
  assertReviewCoverage([file]);
  if (packages.some(pkg => file.startsWith(`${pkg.directory}/`))) return true;
  if (!/^midgard\/change\/[^/]+\.json$/.test(file)) return false;
  const change = JSON.parse(await checkout.git("show", `HEAD:${file}`));
  return Array.isArray(change.changes) && change.changes.length > 0 &&
    change.changes.every(entry => packages.some(pkg => pkg.name === entry.packageName));
}
