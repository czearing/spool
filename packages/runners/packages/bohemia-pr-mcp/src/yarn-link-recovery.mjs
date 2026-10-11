import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Preserve stale pnpm links before Yarn installation; they otherwise shadow healthy hoisted bins.
export function repairYarnWorkspaceLinks(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (!manifest.packageManager?.startsWith("yarn@") || fs.existsSync(path.join(root, "node_modules", ".pnpm"))) return [];
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages || [];
  const recovered = [];
  for (const relative of fs.globSync(patterns, { cwd: root })) {
    const workspace = path.resolve(root, relative);
    if (!workspace.startsWith(path.resolve(root) + path.sep)) throw new Error("Workspace is outside the prepared checkout");
    const modules = path.join(workspace, "node_modules");
    if (!fs.existsSync(modules)) continue;
    const archive = (file) => {
      const backup = path.join(modules, ".creator-link-recovery");
      fs.mkdirSync(backup, { recursive: true });
      const destination = path.join(backup, `${randomUUID()}-${path.basename(file)}`);
      fs.renameSync(file, destination);
      recovered.push({ file, backup: destination });
    };
    const entries = fs.readdirSync(modules, { withFileTypes: true }).flatMap((entry) =>
      entry.name.startsWith("@") && entry.isDirectory()
        ? fs.readdirSync(path.join(modules, entry.name)).map((name) => path.join(modules, entry.name, name))
        : [path.join(modules, entry.name)]);
    for (const file of entries) {
      if (!fs.lstatSync(file).isSymbolicLink()) continue;
      const target = path.resolve(path.dirname(file), fs.readlinkSync(file));
      if (target.includes(`${path.sep}node_modules${path.sep}.pnpm${path.sep}`) && !fs.existsSync(target)) archive(file);
    }
    const bin = path.join(modules, ".bin");
    if (!fs.existsSync(bin)) continue;
    for (const entry of fs.readdirSync(bin, { withFileTypes: true })) {
      if (!entry.isFile() || !["", ".cmd", ".ps1"].includes(path.extname(entry.name).toLowerCase())) continue;
      const file = path.join(bin, entry.name);
      if (fs.readFileSync(file, "utf8").includes(".pnpm")) archive(file);
    }
  }
  return recovered;
}
