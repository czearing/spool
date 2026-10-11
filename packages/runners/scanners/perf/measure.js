#!/usr/bin/env node
import path from "node:path";
import { readRunnerJson } from "../../packages/bohemia-agent-tooling/src/index.js";
import { readVerifiedArtifacts } from "./build.mjs";

try {
  let repoRoot = process.cwd(), receiptPath;
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--repo-root" && argv[index + 1]) repoRoot = path.resolve(argv[++index]);
    else if (argv[index] === "--receipt" && argv[index + 1]) receiptPath = path.resolve(argv[++index]);
    else throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
  }
  if (!receiptPath) throw new Error("Use --receipt <artifact-build.json> from a verified production artifact build");
  const receipt = readRunnerJson(receiptPath);
  process.stdout.write(`${JSON.stringify(readVerifiedArtifacts(repoRoot, receipt), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
