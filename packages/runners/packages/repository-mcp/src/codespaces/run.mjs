import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { CodespaceReview, verifySavedCodespace } from "./review.mjs";
import { CodespaceTransport } from "./transport.mjs";
import { readCodespaceConfig, shellQuote } from "./config.mjs";
import { verifyEngineeringCodespace } from "./engineering.mjs";
import { prepareRepositorySession } from "../client.mjs";

export async function main(argv = process.argv.slice(2)) {
  const [operation, ...args] = argv;
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!["--config", "--pr", "--command", "--mcp-config"].includes(args[index]) || !args[index + 1])
      throw new Error("Usage: prepare|verify|exec --config <absolute file> [--pr <id>] [--command <shell command>]");
    if (values[args[index]]) throw new Error("Duplicate command-line argument");
    values[args[index]] = args[index + 1];
  }
  const config = readCodespaceConfig(values["--config"] || "");
  if (operation === "prepare") {
    if (config.purpose === "engineering") throw new Error("Prepare engineering branches through repo_prepare");
    const id = Number(values["--pr"]);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("A positive PR id is required");
    const pr = await new CodespaceReview(config.file).readPr(id);
    const session = await prepareRepositorySession("1js", {
      repoRoot: config.workspace, operation: "branch", mode: "checkout", reviewPullRequestId: id,
      branch: `review/pr-${id}-${pr.sourceCommit.slice(0, 12)}`, sourceCommit: pr.sourceCommit,
      reset: false, mergeMaster: false, runSetup: true, runBuild: true,
    }, { env: { REPOSITORY_MCP_CONFIG: values["--mcp-config"] || process.env.REPOSITORY_MCP_CONFIG ||
      path.join(os.homedir(), ".copilot", "repository-mcp.json") } });
    let stop;
    const interrupted = new Promise(resolve => { stop = resolve; });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      console.log(JSON.stringify(session.result.structuredContent, null, 2));
      await Promise.race([interrupted, session.closed.then(code => {
        throw new Error(`Reviewer MCP lifecycle ended unexpectedly (${code})`);
      })]);
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      await session.close();
    }
    return;
  }
  const prepared = JSON.parse(fs.readFileSync(path.join(config.workspace, "preparation.json"), "utf8"));
  if (operation !== "exec" || config.purpose !== "engineering")
    await verifySavedCodespace(prepared, { allowRevisionDrift: operation === "exec" });
  if (operation === "verify") {
    console.log(config.purpose === "engineering" ? "Prepared Codespace branch and working revision reverified."
      : "Exact PR revision, repository preparation and workspace ownership reverified.");
    return;
  }
  if (operation !== "exec" || !values["--command"]) throw new Error("Unsupported reviewer operation");
  const transport = new CodespaceTransport(config);
  const engineering = config.purpose === "engineering";
  try {
    if (engineering) {
      await transport.initialize();
      await verifyEngineeringCodespace(prepared, { config, transport, allowWork: true });
    } else await transport.environment();
    const result = await transport.ssh(`cd ${shellQuote(config.remoteRoot)}\n${values["--command"]}`, 3600);
    if (engineering) await verifyEngineeringCodespace(prepared, { config, transport, allowWork: true });
    process.stdout.write(result.stdout);
  } finally {
    if (engineering) await transport.dispose();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
