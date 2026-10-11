import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeJson } from "../../bridge/spool-store.mjs";
import { digest } from "./artifacts.mjs";
import { captureProductionBrowser } from "./browser-runner.mjs";
import { readControlledProof } from "./bundle-proof.mjs";

export async function captureProof({ proofRoot, output, capture = captureProductionBrowser }) {
  assert.ok(path.isAbsolute(proofRoot) && path.isAbsolute(output), "Proof paths must be absolute");
  assert.ok(!existsSync(output), "Use a new output directory; existing evidence is never overwritten");
  const labels = ["baseline", "candidate", "reverted-control"];
  for (const label of labels) {
    assert.ok(existsSync(path.join(proofRoot, label, "apps", "new-office", "dist", "server-entry.js")),
      `Missing runnable production server for ${label}`);
    assert.ok(existsSync(path.join(proofRoot, label, "measurement.json")));
  }
  mkdirSync(output, { recursive: true });
  for (const label of labels) {
    const stage = path.join(output, label);
    cpSync(path.join(proofRoot, label), stage, { recursive: true });
    const record = JSON.parse(readFileSync(path.join(stage, "measurement.json"), "utf8"));
    assert.equal(record.label, label);
    const browser = await capture({ repoRoot: stage, label, commit: record.commit });
    writeJson(path.join(stage, "browser-evidence.json"), browser);
    writeJson(path.join(stage, "measurement.json"),
      { ...record, evidenceVersion: 2, patchSha256: digest(record.patch) });
  }
  const proof = readControlledProof(output);
  const result = { status: "verified", output, scenarios: proof.scenarios,
    rootBefore: proof.rootBefore.brotliBytes, rootAfter: proof.rootAfter.brotliBytes,
    automaticDispatch: false };
  writeJson(path.join(output, "verified.json"), result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 4 && args[0] === "--proof-root" && args[2] === "--output",
      "Use --proof-root <complete-production-snapshots> --output <new-evidence-directory>");
    console.log(JSON.stringify(await captureProof({ proofRoot: args[1], output: args[3] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
