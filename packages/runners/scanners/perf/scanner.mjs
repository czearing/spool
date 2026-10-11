import path from "node:path";
import { readRunnerJson, writeRunnerJson, writeRunnerText } from "../../packages/bohemia-agent-tooling/src/index.js";
import { collectArtifacts } from "./build.mjs";
import { measurementVersion } from "./artifacts.mjs";
import { createInventory, renderInventory, createTodo, renderTodo } from "./report.mjs";
import { readBundleProofs } from "./bundle-proof.mjs";

export function publishTodoBoundary(config) {
  const todo = createTodo();
  writeRunnerJson(config.todoJsonPath, todo);
  writeRunnerText(config.todoPath, renderTodo(todo));
}

export async function runScanner({ config, scan, call }) {
  if (config.defect != null || config.defectOwnerAgentId != null) {
    throw new Error("Automated perf-tool maintenance handoffs are disabled");
  }
  // Remove legacy size-only todos even if artifact collection subsequently fails.
  publishTodoBoundary(config);
  const historyPath = path.join(config.runtimeDirectory, "artifact-history.json");
  const history = readRunnerJson(historyPath);
  if (history && (history.measurementVersion !== measurementVersion || !history.current?.build?.commit ||
      !Array.isArray(history.current.groups))) throw new Error("Invalid artifact history; refusing to invent a baseline");
  const current = await collectArtifacts({
    scan, call, receiptPath: path.join(config.runtimeDirectory, "artifact-build.json"),
  });
  const sameRevision = history?.current.build.commit === current.build.commit;
  if (sameRevision && history.current.fingerprint !== current.fingerprint) {
    throw new Error("Artifacts changed for the same revision; refusing to silently replace the recorded measurement");
  }
  const previous = sameRevision ? history.previous : history?.current ?? null;
  const report = createInventory(current, previous);
  const verified = readBundleProofs(config.runtimeDirectory, current);
  const todo = createTodo(verified);
  writeRunnerJson(historyPath, { measurementVersion, current, previous });
  writeRunnerJson(path.join(config.runtimeDirectory, "inventory.json"), report);
  writeRunnerText(path.join(config.runtimeDirectory, "inventory.md"), renderInventory(report));
  writeRunnerJson(config.todoJsonPath, todo);
  writeRunnerText(config.todoPath, renderTodo(todo));
  return { dispatched: 0, observed: report.groups.length, reason: report.comparison,
    verifiedIssues: verified.issues.length,
    performanceValidation: verified.issues.length ? "validated_bundle_payload" : "not_available",
    holding: verified.issues.length
      ? "Validated bundle issues await manual review; automatic task and tool-maintenance handoffs are disabled"
      : report.dispatchHolding,
    artifactFingerprint: current.fingerprint };
}
