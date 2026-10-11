import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildTaskIssue, readRunnerJson, slugifyBranchTopic } from "../../packages/bohemia-agent-tooling/src/index.js";
import { callBohemia } from "../../packages/bohemia-pr-mcp/src/client.mjs";
import { withAdmission } from "../../bridge/admission.mjs";
import { createSpoolQueue, renderSpoolTaskPrompt } from "../../bridge/queue.mjs";
import { createWorkspacePreparer } from "../../bridge/workspace-preparation.mjs";
import { workload } from "../../bridge/workload.mjs";
import { digest } from "./artifacts.mjs";
import { collectArtifacts, readVerifiedArtifacts } from "./build.mjs";
import { readBundleProofs, verifyBundleProof } from "./bundle-proof.mjs";
import { rootMetric } from "./benchmark.mjs";
import { bundleContract } from "./acceptance.mjs";

export function renderPerformanceTask(issue, workspace, branch) {
  const reproduction = `node "${path.join(import.meta.dirname, "benchmark.mjs")}" --repo-root "${workspace}"`;
  const brief = buildTaskIssue({
    metric: rootMetric, current: issue.initialBrotliBytes.before, target: issue.initialBrotliBytes.after,
    acceptance: issue.initialBrotliBytes.after, unit: "bytes", reproduction,
    repoRoot: workspace, branchName: branch,
  });
  const body = [
    brief.body, "", "## Work",
    `Source: ${issue.sourcePath}`,
    issue.action,
    `Evidence directory: ${issue.evidence.directory}`,
    `Experiment commit: ${issue.evidence.measuredCommit}; applicable checkout commit: ${issue.evidence.observedCommit}.`,
    `Total included JS/CSS Brotli must not exceed ${issue.totalBrotliBytes.before} bytes.`,
    ...issue.scenarios.map(scenario => `${scenario.name}: preserve ${scenario.baseline.requests} raw asset requests; requested JS/CSS sidecar bodies must not exceed ${scenario.baseline.brotliBytes} bytes.`),
    "Reproduce before and after in the assigned checkout. Preserve all route groups and declared browser behavior.",
    "The checked publisher independently rebuilds and captures the required cold/warm/navigation, mobile and alternate-browser-locale workflows, including workers, for five seconds after ready.",
    "Preserve desktop suggestion-to-composer behavior and mobile composer input after dismissing the side panels. The primary cold notebooks-home scenario must improve; every other declared scenario must not regress. Publication and agent completion require matching machine-verified evidence for the committed revision.",
    "Push with bohemia push before creating the PR with bohemia_pr. Confirm the remote branch exists first.",
    issue.limitations,
  ].join("\n");
  return { title: brief.title, body, brief: brief.body };
}

function previewTask({ config, store, workspace, item, allowOneExtraTask }) {
  const current = readVerifiedArtifacts(config.repoRoot,
    readRunnerJson(path.join(config.runtimeDirectory, "artifact-build.json")));
  const issues = readBundleProofs(config.runtimeDirectory, current).issues.filter(issue => issue.id === item);
  if (issues.length !== 1) throw new Error(`Expected one current, proof-backed item ${item}; missing, stale or ambiguous evidence holds release`);
  const issue = issues[0];
  const roleFile = path.join(store.root, "agents", `${config.agentId}.md`);
  const role = readFileSync(roleFile, "utf8");
  const header = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(role)?.[0] ?? "";
  const roleSha256 = digest(role.slice(header.length));
  const agentDefinitionSha256 = digest(role);
  const rendered = renderPerformanceTask(issue, workspace);
  const prompt = renderSpoolTaskPrompt(rendered.body);
  const approval = digest(JSON.stringify({
    agent: config.agentId, workspace, spoolRoot: store.root, agentDefinitionSha256, issue,
    title: rendered.title, prompt, allowOneExtraTask,
  }));
  return {
    status: "preview_only", dispatched: 0, item, agent: config.agentId, workspace,
    roleFile, roleSha256, agentDefinitionSha256, approval, preparationRequired: true, issue,
    allowOneExtraTask,
    title: rendered.title, prompt,
  };
}

export async function performanceHandoff({ config, store, workspace, item, approval,
  maxOpenTasks = 1, allowOneExtraTask = false, call = callBohemia, listPullRequests }) {
  if (typeof item !== "string" || !/^unused-route-export-[A-Z]\w*$/.test(item)) throw new Error("A specific validated bundle item is required");
  if (approval !== undefined && (typeof approval !== "string" || !/^[a-f0-9]{64}$/.test(approval))) {
    throw new Error("Release requires the exact preview approval digest");
  }
  if (!Number.isSafeInteger(maxOpenTasks) || maxOpenTasks < 1) throw new Error("max_open_tasks must be positive");
  if (typeof allowOneExtraTask !== "boolean") throw new Error("A one-task capacity exception must be explicit");
  const result = await withAdmission(store.root, config.agentId, async () => {
    const queue = createSpoolQueue(store, { agent: config.agentId, workspace, runner: "perf" });
    const submissionId = approval ? `bundle-proof:${item}:${approval}` : null;
    if (approval) {
      const existing = await queue.findSubmission(submissionId);
      if (existing) return { status: "already_released", dispatched: 0, taskId: existing.id };
    }
    const preview = previewTask({ config, store, workspace, item, allowOneExtraTask });
    if (approval === undefined) return preview;
    if (approval !== preview.approval) throw new Error("Preview changed; review fresh evidence and prompt before approving release");
    const capability = readRunnerJson(path.join(store.root, "controls", "capabilities.json"));
    const capabilityAge = Date.now() - Date.parse(capability?.updatedAt);
    if (capability?.bundleAcceptanceVersion !== 2 || !Number.isFinite(capabilityAge) || capabilityAge < 0 || capabilityAge > 12000) {
      throw new Error("Native bundle acceptance is unavailable or stale; no task can be released");
    }
    const holding = await workload(store, config.agentId, maxOpenTasks, workspace, config.ado,
      config.legacyBranchPrefixes, listPullRequests, { allowOpenPrOverflow: allowOneExtraTask });
    if (holding) return { status: "held", dispatched: 0, holding };
    const prepare = createWorkspacePreparer({ store, queue, agent: config.agentId, workspace, call });
    const branchSlug = slugifyBranchTopic(item.replace(/^unused-route-export-/, "bundle-"));
    const branchTopic = `perf-${branchSlug.slice(0, 30)}-${approval.slice(0, 8)}`;
    const prepared = await prepare({
      branch: branchTopic, runSetup: true, runBuild: true, reset: false,
      sourceCommit: preview.issue.evidence.observedCommit,
    });
    if (prepared.commit !== preview.issue.evidence.observedCommit) {
      throw new Error("Prepared task revision differs from the approved scan; rescan and review before release");
    }
    const current = await collectArtifacts({ scan: prepared, call,
      receiptPath: path.join(config.runtimeDirectory, "handoff-builds", `${approval}.json`) });
    const verified = verifyBundleProof(preview.issue.evidence.directory, current);
    if (!verified.issue) throw new Error(`Prepared task no longer matches the approved proof: ${verified.stale}`);
    const refreshed = previewTask({ config, store, workspace, item, allowOneExtraTask });
    if (refreshed.approval !== approval) throw new Error("Evidence or role changed during preparation; release held");
    const heldAfterPreparation = await workload(store, config.agentId, maxOpenTasks, workspace, config.ado,
      config.legacyBranchPrefixes, listPullRequests, { allowOpenPrOverflow: allowOneExtraTask });
    if (heldAfterPreparation) return { status: "held", dispatched: 0, holding: heldAfterPreparation };
    readVerifiedArtifacts(workspace, current.build);
    if (digest(readFileSync(preview.roleFile)) !== preview.agentDefinitionSha256) {
      throw new Error("Agent definition changed before publication; release held");
    }
    const rendered = renderPerformanceTask(verified.issue, workspace, prepared.branch);
    const task = await queue.createIssue({
      title: rendered.title, description: rendered.body, assigneeAgentId: config.agentId, submissionId,
      handoff: { item, approval, allowOneExtraTask },
      acceptance: bundleContract(verified.issue),
    });
    const saved = await queue.getIssue(task.id);
    if (saved?.description !== renderSpoolTaskPrompt(rendered.body) || saved.workspace !== workspace) {
      throw new Error(`Spool task ${task.id} failed prompt/workspace readback verification`);
    }
    return { status: "released", dispatched: 1, taskId: task.id, approval, allowOneExtraTask };
  }, [realpathSync(config.repoRoot), realpathSync(workspace)]);
  return result.holding ? { status: "held", ...result } : result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.error("The perf runner and its handoff command are retired. Existing agent tasks and acceptance checks are preserved.");
  process.exitCode = 1;
}
