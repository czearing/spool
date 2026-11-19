import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runOperation } from "../../../bohemia-pr-mcp/src/operations.mjs";
import { executePreparation } from "../../../bohemia-pr-mcp/src/preparation-process.mjs";
import { prepareBranch, refreshUnchanged, mergePreparedTarget } from "../../../bohemia-pr-mcp/src/prepare-branch.mjs";
import { repositoryEnvironment } from "./1js-profile.mjs";
import { repositoryGitCredentials } from "./1js-git-auth.mjs";

const setupRunner = fileURLToPath(new URL("./1js-setup.mjs", import.meta.url));

function prepareNativeBranch(context) {
  const { input, branch, base, git, gitPath, command, stage } = context;
  if (!["resume", "checkout"].includes(input.mode) || input.sourceCommit || input.expectedHead || input.mergeMaster ||
      context.created || input.mode === "resume" && git("branch", "--show-current") !== branch ||
      ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"]
        .some(name => fs.existsSync(gitPath(name))) ||
      git("ls-remote", "--heads", "origin", `refs/heads/${branch}`) ||
      command("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], context.root, true).code !== 0) {
    if (input.mode === "checkout" && input.reset) {
      const result = prepareBranch({ ...context, resetBranch: true });
      if (!result?.conflicted) stage("clean-checkout", () => git("clean", "-fd"));
      return result;
    }
    return prepareBranch(context);
  }
  git("check-ref-format", "--branch", branch);
  if (input.reset) stage("reset", () => {
    git("reset", "--hard", "HEAD");
    git("clean", "-fd");
  });
  stage("branch", () => {
    refreshUnchanged(command);
    if (git("status", "--porcelain")) throw new Error("Checkout is dirty; unpublished work preserved");
    if (input.mode === "checkout") git("checkout", branch);
  });
  if (input.reset) stage("clean-checkout", () => git("clean", "-fd"));
  stage("fetch-master", () => git("fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`));
  stage("base-history", () => git("merge-base", "HEAD", `origin/${base}`));
  return null;
}

export async function prepareRepositoryCheckout(checkout, profile, input, run) {
  const logFile = checkout.receiptPath(`logs/${Date.now()}-prepare.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const { stdout } = await run(profile.nodeExecutable, [
    fileURLToPath(import.meta.url), JSON.stringify({ profile, input }),
  ], { cwd: profile.repoRoot, logFile });
  const result = JSON.parse(stdout);
  if (result.error) throw Object.assign(new Error(`${result.error.message}; log: ${logFile}`), {
    ...(result.error.code ? { code: result.error.code } : {}),
    ...(result.error.reasonCode ? { reasonCode: result.error.reasonCode } : {}),
  });
  if (result.commit !== await checkout.head())
    throw new Error(`HEAD changed during preparation; readiness is not verified; log: ${logFile}`);
  if (!result.ok || !result.ready || result.repoRoot !== profile.repoRoot ||
      result.branch !== await checkout.branch())
    throw new Error(`Preparation result does not match the checkout; log: ${logFile}`);
  return { ...result, steps: [...result.steps, { name: "preparation-log", logFile }] };
}

export async function runRepositoryPreparation(profile, input, dependencies = {}) {
  const credentials = dependencies.authorize ? await dependencies.authorize(profile.repoRoot)
    : await repositoryGitCredentials(profile);
  const environment = { ...repositoryEnvironment(profile), ...credentials.environment };
  return runOperation("prepare", { ...input, baseBranch: input.baseBranch || profile.baseBranch }, {
    environment, redactions: credentials.redactions,
    prepareBranch: context => {
      if (input.mode !== "checkout" || !input.reset || !input.mergeMaster ||
          !input.allowConflicts || input.runBuild !== false || input.runSetup === false)
        return prepareNativeBranch(context);
      prepareNativeBranch({ ...context, input: { ...context.input, mergeMaster: false } });
      context.gate("setup");
      return { ...mergePreparedTarget(context), setupBeforeMerge: true };
    },
    ...(dependencies.execute ? { execute: dependencies.execute } : {}),
    runGate: dependencies.runGate || (operation => {
      const result = executePreparation(profile.nodeExecutable, [
        setupRunner, JSON.stringify({ profile, input, operation }),
      ], profile.repoRoot, environment, 0);
      if (result.output) process.stderr.write(result.output);
      if (result.code !== 0) throw new Error(`Native Codespace ${operation} failed (${result.code}); see retained command logs`);
    }),
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { profile, input } = JSON.parse(process.argv[2]);
  try { process.stdout.write(JSON.stringify(await runRepositoryPreparation(profile, input))); }
  catch (error) {
    process.stdout.write(JSON.stringify({ error: {
      message: error.message, code: error.code, reasonCode: error.reasonCode,
    } }));
  }
}
