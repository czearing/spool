import { spawnSync } from "node:child_process";

const result = spawnSync("cargo", ["test", "--workspace", "--locked", ...process.argv.slice(2), "--", "--test-threads=2"], {
  stdio: "inherit",
  env: { ...process.env, SPOOL_INTERACTIVE_ACP: "1" },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
