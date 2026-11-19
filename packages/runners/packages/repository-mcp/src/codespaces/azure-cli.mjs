import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== "account" || args[1] !== "get-access-token" ||
    args[2] !== "--resource" || !args[3] || !["-o", "--output"].includes(args[4]) || args[5] !== "json")
  throw new Error("Codespace host broker supports only az account get-access-token --resource <approved resource> -o json");
const result = spawnSync(process.execPath, [fileURLToPath(new URL("./azure-helper.mjs", import.meta.url)),
  "get-access-token", args[3], "--json"], { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
if (result.signal) throw new Error(`Host credential helper exited on ${result.signal}`);
process.exitCode = result.status;
