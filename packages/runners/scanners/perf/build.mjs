import path from "node:path";
import { execFileSync } from "node:child_process";
import { callBohemia } from "../../packages/bohemia-pr-mcp/src/client.mjs";
import { readRunnerJson, writeRunnerJson } from "../../packages/bohemia-agent-tooling/src/index.js";
import { measurementVersion, readArtifacts } from "./artifacts.mjs";

export function assertRevision(scan) {
  const git = (...args) => execFileSync("git", args, {
    cwd: scan.repoRoot, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (git("rev-parse", "HEAD") !== scan.commit || git("branch", "--show-current") !== scan.branch ||
      git("status", "--porcelain")) {
    throw new Error("Artifact measurement requires the clean, exact prepared scan revision");
  }
}

export function readVerifiedArtifacts(repoRoot, receipt) {
  if (receipt?.measurementVersion !== measurementVersion || receipt.repoRoot !== repoRoot) {
    throw new Error("The build receipt does not describe this checkout");
  }
  assertRevision(receipt);
  const artifacts = readArtifacts(repoRoot);
  if (artifacts.fingerprint !== receipt.artifactFingerprint) throw new Error("Artifacts no longer match the build receipt");
  assertRevision(receipt);
  return { ...artifacts, build: receipt };
}

export async function buildProductionArtifacts(scan, call = callBohemia) {
  const prepared = await call("bohemia_build", {
    repoRoot: scan.repoRoot, packages: ["@fluidx/new-office"], productionArtifacts: true,
  });
  if (!prepared?.ready || !prepared.productionArtifacts || prepared.commit !== scan.commit ||
      prepared.branch !== scan.branch || path.resolve(prepared.repoRoot ?? "") !== path.resolve(scan.repoRoot)) {
    throw new Error("Bohemia did not confirm production artifacts for the requested scan revision");
  }
  return prepared;
}

export async function collectArtifacts({ scan, receiptPath, call = callBohemia }) {
  assertRevision(scan);
  const receipt = readRunnerJson(receiptPath);
  const reusable = receipt?.measurementVersion === measurementVersion &&
    receipt.commit === scan.commit && receipt.repoRoot === scan.repoRoot;
  if (reusable) {
    const artifacts = readArtifacts(scan.repoRoot);
    if (artifacts.fingerprint !== receipt.artifactFingerprint) {
      throw new Error("Production artifacts changed after their verified build; remove the artifact build receipt and rebuild");
    }
    assertRevision(scan);
    return { ...artifacts, build: receipt };
  }
  await buildProductionArtifacts(scan, call);
  assertRevision(scan);
  const artifacts = readArtifacts(scan.repoRoot);
  const build = {
    measurementVersion, repoRoot: scan.repoRoot, commit: scan.commit, branch: scan.branch,
    builtAt: new Date().toISOString(), tool: "bohemia_build", productionArtifacts: true,
    packages: ["@fluidx/new-office"], artifactFingerprint: artifacts.fingerprint,
    platform: process.platform, architecture: process.arch, collectorNode: process.version,
  };
  writeRunnerJson(receiptPath, build);
  return { ...artifacts, build };
}
