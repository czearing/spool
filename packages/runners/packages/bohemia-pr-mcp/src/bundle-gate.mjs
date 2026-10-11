import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const read = file => JSON.parse(readFileSync(file, "utf8"));
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function findBundleContract({ repoRoot, branch, context, environment = process.env }) {
  if (!context && environment.BOHEMIA_CREATOR_CONTEXT) context = read(environment.BOHEMIA_CREATOR_CONTEXT);
  const config = path.resolve(import.meta.dirname, "..", "..", "..", "spool-runners.json");
  const root = environment.SPOOL_ROOT || environment.SPOOL_DIR || (context?.originKind === "spool" && context.receiptDirectory
    ? path.dirname(path.dirname(context.receiptDirectory))
    : existsSync(config) ? read(config).spool_dir : null);
  if (!root) {
    assert.ok(!context?.acceptance, "Bundle task root is unavailable; publication refused");
    return null;
  }
  assert.ok(path.isAbsolute(root), "Spool root must be absolute");
  const directory = path.join(root, ".runner-receipts", "bundle-contracts");
  const matches = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".json"))
    .map(name => read(path.join(directory, name))).filter(record => record.branch === branch.replace(/^refs\/heads\//, "")) : [];
  if (!matches.length) {
    assert.ok(!context?.acceptance, "Bundle contract registry missing; publication refused");
    const receipts = path.join(root, ".runner-receipts");
    if (existsSync(receipts)) {
      for (const file of readdirSync(receipts).filter(name => /^task-.+\.json$/.test(name))) {
        const metadata = read(path.join(receipts, file));
        if (metadata.preparation?.branch !== branch.replace(/^refs\/heads\//, "")) continue;
        let guarded = !!metadata.acceptance;
        for (const status of ["incoming", "in_progress", "completed", "failed"]) {
          const taskFile = path.join(root, "queues", status, file.slice(5));
          if (existsSync(taskFile)) guarded ||= !!read(taskFile).acceptance;
        }
        assert.ok(!guarded, "Bundle contract registry missing; publication refused");
      }
    }
    return null;
  }
  assert.equal(matches.length, 1, "Ambiguous bundle task ownership");
  const record = matches[0];
  assert.equal(record.version, 1);
  assert.equal(record.acceptance?.kind, "bundle-v2");
  assert.ok(same(record.workspace, repoRoot), "Bundle task must publish from its assigned checkout");
  if (context?.taskId && context.agent !== "pr-updater" && !context.agent?.startsWith("pr-updater-")) {
    assert.equal(record.taskId, context.taskId, "Another task owns this bundle branch");
  }
  return { root, taskId: record.taskId, acceptance: record.acceptance };
}

async function implementation(binding) {
  const file = binding.acceptance.verifier;
  assert.ok(path.isAbsolute(file) && path.basename(file) === "verify-task.mjs" && existsSync(file),
    "Bundle verifier is unavailable; publication refused");
  return import(pathToFileURL(path.join(path.dirname(file), "acceptance.mjs")));
}

export async function prepareBundlePublication(options) {
  const binding = findBundleContract(options);
  if (!binding) return null;
  const validator = await implementation(binding);
  await validator.recordBundleAcceptance({ root: binding.root, taskId: binding.taskId, headCommit: options.headCommit });
  return { ...binding, headCommit: options.headCommit };
}

export async function finishBundlePublication(binding, pr) {
  if (!binding) return;
  const validator = await implementation(binding);
  validator.recordBundlePublication({ root: binding.root, taskId: binding.taskId, headCommit: binding.headCommit, pr });
}
