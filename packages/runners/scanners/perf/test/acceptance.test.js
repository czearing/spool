import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeJson } from "../../../bridge/spool-store.mjs";
import { findBundleContract } from "../../../packages/bohemia-pr-mcp/src/bundle-gate.mjs";
import { appPath, readArtifacts } from "../artifacts.mjs";
import { bundleContract, recordBundleAcceptance, recordBundlePublication, verifyBundleAcceptance } from "../acceptance.mjs";
import { verifyBundleProof } from "../bundle-proof.mjs";
import { browserEvidenceFixture, proofFixture } from "./fixtures.js";

export function acceptanceFixture(t) {
  const f = proofFixture(t);
  const contract = bundleContract(verifyBundleProof(f.directory, f.current).issue);
  f.git("add", "."); f.git("commit", "-qm", "prepared source");
  cpSync(path.join(f.directory, "candidate", appPath), f.app, { recursive: true });
  writeFileSync(path.join(f.repoRoot, f.sourcePath), f.afterSource);
  f.git("add", "."); f.git("commit", "-qm", "candidate");
  const commit = f.git("rev-parse", "HEAD"), id = "bundle-task", session = randomUUID(), origin = randomUUID();
  f.put({ id, agent: "perf", workspace: f.repoRoot, session_id: session, acceptance: contract }, "in_progress");
  const metadata = { taskId: id, acceptance: contract,
    preparation: { ready: true, repoRoot: f.repoRoot, branch: "master", commit } };
  writeJson(path.join(f.store.records, `task-${id}.json`), metadata);
  const registry = { version: 1, taskId: id, agent: "perf", workspace: f.repoRoot, branch: "master", acceptance: contract };
  writeJson(path.join(f.store.records, "bundle-contracts", `${id}.json`), registry);
  const pr = { pullRequestId: 123, sourceRefName: "refs/heads/master", lastMergeSourceCommit: { commitId: commit },
    description: `<!-- bohemia-origin:${origin} -->\nPublished fixture` };
  const capture = async options => browserEvidenceFixture(
    readArtifacts(options.repoRoot, { includeExcluded: true }), options.commit, options.label);
  const options = { root: f.root, taskId: id, headCommit: commit, capture, call: async (tool, args) => {
    assert.equal(tool, "bohemia_build");
    assert.equal(args.repoRoot, f.repoRoot);
    assert.equal(args.productionArtifacts, true);
    return { ready: true, productionArtifacts: true, repoRoot: f.repoRoot, branch: "master", commit };
  } };
  const creator = { verified: true, taskId: id, sessionId: session, agent: "perf", workspace: f.repoRoot,
    prId: "123", originId: origin, branch: "master" };
  const publish = () => {
    writeJson(path.join(f.store.records, "native-creators", `${id}.json`), creator);
    return recordBundlePublication({ root: f.root, taskId: id, headCommit: commit, pr });
  };
  return { ...f, contract, id, session, commit, options, registry, creator, pr, publish,
    evidenceFile: path.join(f.store.records, "bundle-evidence", id, `${commit}.json`) };
}

test("independent acceptance binds the task, source, artifacts, browser evidence and remote publication", async t => {
  const f = acceptanceFixture(t);
  assert.throws(() => verifyBundleAcceptance(f.options), /acceptance is missing/);
  const result = await recordBundleAcceptance(f.options);
  assert.equal(result.status, "verified");
  assert.equal(result.taskId, f.id);
  assert.equal(result.commit, f.commit);
  assert.ok(result.value <= f.contract.rootMaxBytes);
  assert.throws(() => verifyBundleAcceptance({ ...f.options, requirePublication: true }), /publication is missing/);
  const delivered = f.publish();
  assert.equal(delivered.prId, "123");
  let calls = 0;
  await recordBundleAcceptance({ ...f.options, call: async () => { calls++; }, capture: async () => { calls++; } });
  assert.equal(calls, 0, "Exact immutable evidence can be reverified without a repeated build/browser run");
});

for (const defect of ["wrong-task", "wrong-session", "wrong-policy", "wrong-commit", "wrong-source",
  "wrong-body", "missing-scenario", "failed-behavior", "wrong-route", "missing-evidence",
  "changed-contract", "missing-registry", "missing-publication", "wrong-published-head", "wrong-pr", "changed-assets"]) {
  test(`acceptance rejects ${defect} rather than trusting an after number`, async t => {
    const f = acceptanceFixture(t);
    await recordBundleAcceptance(f.options);
    f.publish();
    const evidence = JSON.parse(readFileSync(f.evidenceFile, "utf8"));
    if (defect === "wrong-task") evidence.taskId = "another";
    if (defect === "wrong-session") evidence.sessionId = randomUUID();
    if (defect === "wrong-policy") evidence.browser.policyHash = "stale";
    if (defect === "wrong-commit") evidence.source.commit = "b".repeat(40);
    if (defect === "wrong-body") evidence.browser.cases[0].waterfall[0].bodySha256 = "other";
    if (defect === "missing-scenario") evidence.browser.cases.pop();
    if (defect === "failed-behavior") evidence.browser.cases[0].assertions[0].status = "failed";
    if (defect === "wrong-route") evidence.browser.cases[0].route = "/another";
    writeJson(f.evidenceFile, evidence);
    if (defect === "missing-evidence") rmSync(f.evidenceFile);
    if (defect === "wrong-source") writeFileSync(path.join(f.repoRoot, f.sourcePath), "uncommitted change");
    if (defect === "changed-assets") {
      const file = path.join(f.app, "dist", "client", "assets", "js", "index.abc.js");
      writeFileSync(file, "wrong output");
    }
    if (defect === "changed-contract") {
      const task = f.store.task(f.id);
      task.acceptance.rootMaxBytes++;
      writeJson(task.file, task);
    }
    if (defect === "missing-registry") rmSync(path.join(f.store.records, "bundle-contracts", `${f.id}.json`));
    const publishedFile = path.join(f.store.records, "bundle-publications", `${f.id}.json`);
    if (defect === "missing-publication") rmSync(publishedFile);
    if (defect === "wrong-published-head" || defect === "wrong-pr") {
      const published = JSON.parse(readFileSync(publishedFile, "utf8"));
      if (defect === "wrong-published-head") published.commit = "b".repeat(40);
      else published.prId = "456";
      writeJson(publishedFile, published);
    }
    assert.throws(() => verifyBundleAcceptance({ ...f.options, requirePublication: true }));
  });
}

test("new committed revisions cannot reuse previous performance evidence", async t => {
  const f = acceptanceFixture(t);
  await recordBundleAcceptance(f.options);
  f.publish();
  writeFileSync(path.join(f.repoRoot, "source.txt"), "another revision");
  f.git("add", "."); f.git("commit", "-qm", "new revision");
  assert.throws(() => verifyBundleAcceptance({ root: f.root, taskId: f.id, requirePublication: true }), /acceptance is missing/);
});

test("publication requires the remotely confirmed source and original origin", async t => {
  const f = acceptanceFixture(t);
  await recordBundleAcceptance(f.options);
  writeJson(path.join(f.store.records, "native-creators", `${f.id}.json`), f.creator);
  for (const pr of [
    { ...f.pr, lastMergeSourceCommit: { commitId: "b".repeat(40) } },
    { ...f.pr, description: "No original marker" },
    { ...f.pr, pullRequestId: 456 },
  ]) assert.throws(() => recordBundlePublication({ ...f.options, pr }));
  assert.ok(!existsSync(path.join(f.store.records, "bundle-publications", `${f.id}.json`)));
});

test("publisher lookup binds the original branch independently of draft category and caller", t => {
  const f = acceptanceFixture(t);
  const options = { repoRoot: f.repoRoot, branch: "master", environment: { SPOOL_ROOT: f.root } };
  assert.equal(findBundleContract(options).taskId, f.id);
  assert.equal(findBundleContract({ ...options, branch: "unrelated" }), null);
  assert.throws(() => findBundleContract({ ...options, repoRoot: f.workspace }), /assigned checkout/);
  assert.throws(() => findBundleContract({ ...options, context: { taskId: "another-task" } }), /owns/);
  rmSync(path.join(f.store.records, "bundle-contracts", `${f.id}.json`));
  assert.throws(() => findBundleContract(options), /registry missing/, "Updates cannot evade a missing registry");
  assert.throws(() => findBundleContract({ ...options, context: { acceptance: f.contract } }), /registry missing/);
});

test("actual native MCP rejects unverified completion and accepts the verified original publication", async t => {
  const f = acceptanceFixture(t);
  const binary = process.env.SPOOL_TEST_BINARY ||
    fileURLToPath(new URL("../../../../spool/target/debug/spool.exe", import.meta.url));
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "spool_update_task_status", arguments: { status: "completed", comment: "after: 1" } } };
  const invoke = () => {
    const output = spawnSync(binary, ["--root", f.root, "mcp", "--agent", "perf", "--task", f.id], {
      input: JSON.stringify(request) + "\n", encoding: "utf8", windowsHide: true, timeout: 30000,
    });
    assert.equal(output.status, 0, `${output.error ?? ""}\n${output.stderr}`);
    return JSON.parse(output.stdout.trim()).result;
  };
  assert.equal(invoke().isError, true);
  assert.equal(f.store.task(f.id).status, "in_progress");
  await recordBundleAcceptance(f.options);
  assert.equal(invoke().isError, true, "Evidence alone cannot stand in for PR publication");
  f.publish();
  assert.notEqual(invoke().isError, true);
  const saved = f.store.task(f.id);
  assert.equal(saved.status, "completed");
  assert.deepEqual(saved.acceptance, f.contract);
  assert.ok(saved.comments.some(comment => comment.author === "spool:acceptance"));
});
