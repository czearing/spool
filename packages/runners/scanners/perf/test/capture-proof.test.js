import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { proofFixture, browserEvidenceFixture } from "./fixtures.js";
import { captureProof } from "../capture-proof.mjs";
import { appPath, readArtifacts } from "../artifacts.mjs";

test("proof capture creates new evidence, verifies all stages and cannot overwrite its input", async t => {
  const f = proofFixture(t), output = path.join(f.root, "recaptured");
  for (const label of ["baseline", "candidate", "reverted-control"]) {
    writeFileSync(path.join(f.directory, label, appPath, "dist", "server-entry.js"), "// Fixture: capture injected");
  }
  const original = readFileSync(path.join(f.directory, "baseline", "measurement.json"), "utf8"), seen = [];
  const result = await captureProof({ proofRoot: f.directory, output, capture: async options => {
    seen.push(options.label);
    return browserEvidenceFixture(readArtifacts(options.repoRoot, { includeExcluded: true }), options.commit, options.label);
  } });
  assert.deepEqual(seen, ["baseline", "candidate", "reverted-control"]);
  assert.equal(result.status, "verified");
  assert.equal(result.automaticDispatch, false);
  assert.equal(readFileSync(path.join(f.directory, "baseline", "measurement.json"), "utf8"), original);
  assert.ok(existsSync(path.join(output, "verified.json")));
  await assert.rejects(captureProof({ proofRoot: f.directory, output }), /never overwritten/);
  const rejected = path.join(f.root, "rejected");
  await assert.rejects(captureProof({ proofRoot: f.directory, output: rejected,
    capture: async () => { throw new Error("Browser scenario failed"); } }), /scenario failed/);
  assert.ok(!existsSync(path.join(rejected, "verified.json")));
});
