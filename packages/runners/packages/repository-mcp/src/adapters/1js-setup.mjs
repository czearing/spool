import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execute } from "../process.mjs";
import { openCheckout } from "../checkout.mjs";
import { repositoryEnvironment, assertRepositoryRoot } from "./1js-profile.mjs";
import { ensureRepositoryNode } from "./1js-node.mjs";
import { packageNames, selectedPackages, scopedCommands } from "./1js-packages.mjs";
import { invalidateObsoleteDependencyPatches, validateDependencyPatchCache } from "./1js-patch-cache.mjs";

async function materializeSelectedSources(checkout, profile, selectors) {
  const requested = packageNames(selectors);
  if (await checkout.git("config", "--get", "--default", "false", "core.sparseCheckout") !== "true") return;
  const entries = (await checkout.git("ls-files", "-t", "-z", "--", ":(glob)**/package.json"))
    .split("\0").filter(Boolean);
  const preferred = entry => requested.some(name =>
    name.split("/").at(-1) === path.posix.basename(path.posix.dirname(entry.slice(2))));
  entries.sort((left, right) => Number(preferred(right)) - Number(preferred(left)));
  const found = new Set(), directories = new Set();
  for (const entry of entries) {
    const file = entry.slice(2), directory = path.posix.dirname(file);
    const manifestFile = path.join(profile.repoRoot, file), present = fs.existsSync(manifestFile);
    if (!present && !entry.startsWith("S ")) continue;
    const manifest = JSON.parse(present ? fs.readFileSync(manifestFile, "utf8")
      : await checkout.git("show", `HEAD:${file}`));
    const matches = requested.filter(name => name === manifest.name || name === path.posix.basename(directory));
    if (matches.length) {
      matches.forEach(name => found.add(name));
      if (!present) directories.add(directory);
    }
    if (found.size === requested.length) break;
  }
  if (found.size === requested.length && directories.size)
    await checkout.git("sparse-checkout", "add", "--", ...directories);
}

export async function setupRepository(profile, input, operation, dependencies = {}) {
  assertRepositoryRoot(profile);
  profile = await ensureRepositoryNode(profile);
  const env = repositoryEnvironment(profile), run = dependencies.execute || execute;
  const checkout = await (dependencies.openCheckout || openCheckout)(profile.repoRoot, { run, env });
  if (operation === "setup" && input.packages)
    await materializeSelectedSources(checkout, profile, input.packages);
  const sourceFiles = input.operation === "branch" && input.mergeMaster
    ? await checkout.changedFiles(`refs/remotes/origin/${profile.baseBranch}`) : undefined;
  const packages = await selectedPackages(checkout, profile, input, sourceFiles);
  const invoke = async (command, args, cwd, name) => {
    fs.mkdirSync(path.join(profile.stateRoot, "command-logs"), { recursive: true });
    const logFile = path.join(profile.stateRoot, "command-logs", `${Date.now()}-${randomUUID()}.log`);
    const commandEnv = name === "scoped-install" ? { ...env, MIDGARD_SKIP_ROOT_LINT: "1" }
      : name === "scoped-build" ? { ...env,
        BACKFILL_MODE: env.BACKFILL_MODE ?? "READ_WRITE",
        BACKFILL_INTERNAL_CACHE_FOLDER: env.BACKFILL_INTERNAL_CACHE_FOLDER ??
          env.MIDGARD_BACKFILL_CACHE_DIR ?? path.join(profile.stateRoot, "build-cache"),
        LAGE_WRITE_REMOTE_CACHE: env.LAGE_WRITE_REMOTE_CACHE ?? "false",
      } : env;
    const result = await run(command === "node" ? profile.nodeExecutable : command, args, { cwd, env: commandEnv, logFile });
    if (name === "scoped-install") {
      const warnings = [...(result.output || result.stdout || "")
        .matchAll(/We (?:didn't|did not) find any packages that match ([^\r\n]+)/gi)];
      const unmatched = warnings.map(([, message]) => message.split(". This argument")[0]
        .trim().replace(/^['"`]|['"`]$/g, ""));
      if (unmatched.some(selector => packages.some(pkg => pkg.name === selector)))
        throw new Error(`Scoped installation did not match the requested packages; log: ${logFile}`);
    }
    return { name, command, args, cwd, logFile };
  };
  const build = async () => {
    const workspace = JSON.parse(fs.readFileSync(path.join(profile.workspaceRoot, "package.json"), "utf8"));
    if (workspace.scripts?.["build-scope"] &&
        packages.every(pkg => pkg.directory.startsWith("midgard/")))
      return [await invoke("yarn", ["build-scope", ...packages.map(pkg => pkg.name)],
        profile.workspaceRoot, "scoped-build")];
    return scopedCommands(packages, "build", invoke);
  };
  const steps = [];
  if (operation === "setup") {
    const installNames = packages.map(pkg => pkg.name);
    const installTool = path.join(profile.workspaceRoot, "packages", "ci-scripts", "package.json");
    if (fs.existsSync(installTool)) {
      const tool = JSON.parse(fs.readFileSync(installTool, "utf8"));
      if (tool.name === "@1js/ci-scripts") {
        // CI's postinstall bundles these tools; cached transitive sources lack their linker dependencies.
        const tools = [tool.name, ...Object.keys(tool.dependencies || {}).filter(name => name.startsWith("@1js/"))];
        for (const name of tools) if (!installNames.includes(name)) installNames.push(name);
      }
    }
    const scopeFile = path.join(profile.workspaceRoot, ".scoper", "userScope.json");
    if (fs.existsSync(scopeFile) &&
        await checkout.git("config", "--get", "--default", "false", "core.sparseCheckout") === "true") {
      const scope = JSON.parse(fs.readFileSync(scopeFile, "utf8"));
      const focused = scope.focus?.["git-sparse-checkout"]?.packages || {};
      const missing = installNames.filter(name => !Object.hasOwn(focused, name));
      if (missing.length)
        steps.push(await invoke("yarn", ["scoper", "sparse-checkout", "add", ...missing,
          "--type", "package", "--quiet"], profile.workspaceRoot, "sparse-package-selection"));
    }
    const obsolete = await invalidateObsoleteDependencyPatches(profile, env, checkout);
    if (obsolete.length) steps.push({ name: "obsolete-dependency-patches", entries: obsolete });
    steps.push(await invoke("yarn", ["fast", ...installNames], profile.workspaceRoot, "scoped-install"));
    const installed = { packages: packages.map(pkg => pkg.name) };
    await selectedPackages(checkout, profile, installed);
    if (/^(?:true|1)$/i.test(env.SKIP_DEPENDENCY_PATCHING || ""))
      throw new Error("Required stock dependency patching cannot be skipped");
    const stale = validateDependencyPatchCache(profile, packages, env, true);
    steps.push(await invoke("yarn", ["patch-dependencies"], profile.workspaceRoot, "dependency-patches"));
    if (stale.some(marker => !fs.existsSync(marker)))
      throw new Error("Stock dependency patching did not restore its invalidated generated markers");
    validateDependencyPatchCache(profile, packages, env);
    if (input.runBuild !== false) steps.push(...await build());
    if (packages.some(pkg => ({ ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies })["@1js/jest-config"])) {
      // Ignored test-toolchain output survives branch resets and can reference a different revision's sources.
      const prepared = new Set();
      for (const pkg of packages.filter(pkg =>
        ({ ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies })["@1js/jest-config"])) {
        const file = createRequire(path.join(pkg.root, "package.json")).resolve("@1js/jest-config/package.json");
        const root = fs.realpathSync(path.dirname(file)), relative = path.relative(profile.repoRoot, root);
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        const script = manifest.scripts?.prepare ? "prepare" : manifest.scripts?.build ? "build" : null;
        if (relative.startsWith("..") || path.isAbsolute(relative) ||
            manifest.name !== "@1js/jest-config" || !script)
          throw new Error("Jest preparation requires its checkout-local stock prepare or build script");
        if (!prepared.has(root)) {
          const configFile = path.join(root, "tsconfig.json");
          if (manifest.scripts[script] === "tsc" && fs.existsSync(configFile)) {
            const compiler = createRequire(file)("typescript");
            const parsed = compiler.readConfigFile(configFile, compiler.sys.readFile);
            if (parsed.error) throw new Error("Cannot read the stock Jest compiler configuration");
            const options = parsed.config.compilerOptions;
            if (typeof options?.tsBuildInfoFile === "string" && typeof options.outDir === "string") {
              const info = path.resolve(root, options.tsBuildInfoFile), output = path.resolve(root, options.outDir);
              if (!output.startsWith(root + path.sep) || !info.startsWith(output + path.sep))
                throw new Error("Jest incremental metadata must remain in its generated output directory");
              if (fs.existsSync(info)) {
                if (!fs.lstatSync(info).isFile() || fs.lstatSync(info).isSymbolicLink() ||
                    fs.realpathSync(path.dirname(info)) !== path.dirname(info) ||
                    await checkout.git("ls-files", "--", path.relative(profile.repoRoot, info)))
                  throw new Error("Jest incremental metadata is not a disposable generated file");
                // Branch changes can leave stale JavaScript alongside otherwise valid incremental metadata.
                fs.rmSync(info);
              }
            }
          }
          steps.push(await invoke("yarn", [script], root, "test-toolchain"));
          prepared.add(root);
        }
        steps.push(await invoke("node", ["-e", 'require("@1js/jest-config")'], pkg.root, "test-toolchain-verification"));
      }
    }
  } else if (operation === "build") steps.push(...await build());
  else throw new Error("Unsupported 1JS preparation operation");
  return { ready: true, steps, packages: packages.map(pkg => pkg.name), buildWarmed: input.runBuild !== false };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { profile, input, operation } = JSON.parse(process.argv[2]);
  process.stdout.write(JSON.stringify(await setupRepository(profile, input, operation)));
}
