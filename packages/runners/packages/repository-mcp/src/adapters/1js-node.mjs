import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { execute } from "../process.mjs";

function versionTools(profile) {
  const manifests = [
    path.join(profile.workspaceRoot, "package.json"),
    path.join(path.dirname(profile.nodeExecutable), "node_modules", "npm", "package.json"),
    path.resolve(path.dirname(profile.nodeExecutable), "..", "lib", "node_modules", "npm", "package.json"),
  ];
  for (const manifest of manifests) {
    try { return createRequire(manifest)("semver"); }
    catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  }
  throw new Error("Cannot read Node requirements: the checkout or registered Node installation must provide semver");
}

export async function ensureRepositoryNode(profile, { run = execute, fetch = globalThis.fetch,
  platform = process.platform, arch = process.arch } = {}) {
  const manifest = path.join(profile.workspaceRoot, "package.json");
  if (!fs.existsSync(manifest)) return profile;
  const engine = JSON.parse(fs.readFileSync(manifest, "utf8")).engines?.node;
  if (!engine) return profile;
  const semver = versionTools(profile);
  const pin = [path.join(profile.workspaceRoot, ".nvmrc"), path.join(profile.repoRoot, ".nvmrc")]
    .find(file => fs.existsSync(file));
  const ranges = [engine, ...(pin ? [fs.readFileSync(pin, "utf8").trim()] : [])];
  if (ranges.some(range => !semver.validRange(range)))
    throw new Error("The checkout has unsupported Node version requirements");
  const accepts = version => !!semver.valid(version) && ranges.every(range => semver.satisfies(version, range));
  const candidates = [profile.nodeExecutable];
  const cache = path.join(profile.storageRoot, "toolchains", "node");
  const roots = [path.dirname(path.dirname(profile.nodeExecutable)), cache];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).sort().reverse())
      if (/^node-v\d+\.\d+\.\d+-/.test(name))
        candidates.push(path.join(root, name, "bin", "node"));
  }
  const usable = async file => {
    if (!fs.existsSync(file)) return false;
    const result = await run(file, ["--version"], { cwd: profile.repoRoot });
    return accepts(result.stdout.trim().replace(/^v/, ""));
  };
  for (const nodeExecutable of new Set(candidates))
    if (await usable(nodeExecutable)) return { ...profile, nodeExecutable };
  const required = semver.minVersion(ranges.join(" "));
  if (!required || !accepts(required.version))
    throw new Error(`The checkout's Node requirements are incompatible: ${ranges.join(", ")}`);
  if (platform !== "linux" || !["x64", "arm64"].includes(arch))
    throw new Error(`Install Node ${required.version} for this registered workspace`);
  const distribution = `node-v${required.version}-linux-${arch}`;
  const directory = path.join(cache, distribution);
  const stage = path.join(cache, `.install-${randomUUID()}`);
  const archiveName = `${distribution}.tar.xz`;
  const archive = `${stage}.tar.xz`;
  const base = `https://nodejs.org/dist/v${required.version}/`;
  fs.mkdirSync(stage, { recursive: true });
  try {
    const get = async name => {
      const response = await fetch(base + name, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`Node ${required.version} download failed (${response.status})`);
      return response;
    };
    const sums = await (await get("SHASUMS256.txt")).text();
    const expected = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/))
      .find(([, name]) => name === archiveName)?.[0];
    if (!/^[a-f0-9]{64}$/.test(expected || "")) throw new Error("Official Node checksum is missing");
    const bytes = Buffer.from(await (await get(archiveName)).arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error("Downloaded Node runtime failed official checksum verification");
    fs.writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
    await run("tar", ["-xJf", archive, "--strip-components=1", "-C", stage], { cwd: profile.repoRoot });
    const staged = path.join(stage, "bin", "node");
    const version = (await run(staged, ["--version"], { cwd: profile.repoRoot })).stdout.trim().replace(/^v/, "");
    if (version !== required.version) throw new Error("Installed Node runtime does not match the verified release");
    fs.renameSync(stage, directory);
    return { ...profile, nodeExecutable: path.join(directory, "bin", "node") };
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
