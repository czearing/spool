const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function runDedupeDiagnostics(repoRoot, spawn = spawnSync) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  if (manifest.scripts?.["dedupe:diagnostics"] !== "node common/scripts/pnpmDedupeDiagnostics.cjs") {
    throw new Error("Unsupported dedupe diagnostics script; update the Windows launcher to match the repository");
  }
  const { runDiagnostics } = require(path.join(repoRoot, "common", "scripts", "pnpmDedupeDiagnostics.cjs"));
  // Execute the repository's check and diagnostics unchanged, using a shell only for Windows command shims.
  return runDiagnostics(["--check"], (command, args, options) => {
    const shim = process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
    return spawn(shim ? process.env.ComSpec || "cmd.exe" : command,
      shim ? ["/d", "/s", "/c", command, ...args] : args,
      { ...options, cwd: repoRoot });
  });
}

if (require.main === module) {
  if (!path.isAbsolute(process.argv[2] || "")) throw new Error("Absolute repoRoot is required");
  process.exitCode = runDedupeDiagnostics(process.argv[2]);
}

module.exports = { runDedupeDiagnostics };
