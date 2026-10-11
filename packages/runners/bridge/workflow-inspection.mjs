import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { profile } from "./sources.mjs";
import { keyFor } from "./config.mjs";
import { eventSource, isTrigger } from "@spool/workflow";
import { handoffInstructions, withHandoffInstructions } from "./managed-settings.mjs";
import { renderSpoolTaskPrompt } from "./queue.mjs";

const placeholder = name => `{{${name}}}`;
export async function inspectWorkflow(input, value) {
  const source = eventSource(value), inspection = Object.fromEntries(value.nodes.map(node => [node.id, { context: {} }]));
  const setting = value.kind === "managed" ? input[keyFor(value.id)] || {} : {};
  const base = source ? profile(source) : {}, ado = input.ado || {};
  const trigger = value.nodes.find(isTrigger), handoff = value.nodes.find(node => node.kind === "agent");
  const template = prompt => handoff.prompt.replaceAll("{{event.prompt}}", () => prompt);
  const instructions = handoffInstructions(setting);
  if (source) inspection[trigger.id].context = { organization: ado.organization || base.organization,
    project: ado.project || base.project, repository: ado.repository || base.repository };
  if (source === "pr-reviewer" && handoff) {
    inspection[trigger.id].context.scopes = ado.organization && ado.project
      ? [{ organization: ado.organization, project: ado.project }] : base.scopes;
    const { taskBody } = await import("../scanners/pr-reviewer/lib/work-queue.mjs");
    const body = taskBody(Object.fromEntries(["id", "title", "url", "sourceCommit"].map(key => [key, placeholder(`pr.${key}`)])),
      { transport: "spool" }, { branch: placeholder("prepared.branch"), repoRoot: value.workspace });
    inspection[handoff.id].prompt = renderSpoolTaskPrompt(template(body), handoff.agent, instructions, source);
  } else if (source === "livesite" && handoff) {
    inspection[trigger.id].context.pipelines = base.definitions;
    const { incidentPrompt } = await import("../scanners/livesite/lib/delivery.mjs");
    const assessment = { kind: placeholder("incident.kind"), summary: placeholder("incident.summary"),
      build: Object.fromEntries(["id", "number", "url", "sourceBranch", "sourceVersion"].map(key => [key, placeholder(`build.${key}`)])) };
    inspection[handoff.id].prompt = renderSpoolTaskPrompt(
      template(incidentPrompt(assessment, placeholder("prepared.branch"), value.workspace)), handoff.agent, instructions);
  } else if (source === "pr-updater" && handoff) {
    const { readReviewProcedure, reviewPrompt } = await import("../scanners/lib/creator-review.mjs");
    const contract = Object.fromEntries(["submissionId", "fingerprint", "prId", "head", "branch", "url", "cwd", "identifier",
      "agent", "resultFile", "descriptionBaseline"].map(key => [key, placeholder(`contract.${key}`)]));
    contract.version = 2; contract.responseMode = "pr_description";
    contract.findings = [Object.fromEntries(["threadId", "text"].map(key => [key, placeholder(`finding.${key}`)]))];
    inspection[handoff.id].prompt = template(reviewPrompt(contract,
      withHandoffInstructions(await readReviewProcedure(), instructions), { transport: "spool" }));
    inspection[handoff.id].agentSource = "Original creator's agent instructions; resolved for each PR, not the pr-updater agent.";
  } else if (source === "perf" && handoff) {
    const { performanceDiscoveryPrompt } = await import("./perf-discovery.mjs");
    inspection[handoff.id].prompt = performanceDiscoveryPrompt();
  }
  for (const node of value.nodes.filter(node => node.kind === "agent" && node.operation !== "resume-event")) {
    const detail = inspection[node.id];
    if (!/^[a-z0-9][a-z0-9-]*$/.test(node.agent)) { detail.error = "No valid agent is configured."; continue; }
    const file = path.join(input.spool_dir, "agents", `${node.agent}.md`);
    detail.agentSource = file;
    try {
      if (statSync(file).size > 256000) throw new Error("Agent instructions exceed the 256 KB preview limit.");
      detail.agentInstructions = readFileSync(file, "utf8");
    } catch (error) {
      if (error.code && !["ENOENT", "EACCES"].includes(error.code)) throw error;
      detail.error = error.code === "ENOENT" ? "Agent instructions file is missing." :
        error.code === "EACCES" ? "Agent instructions cannot be read." : error.message;
    }
  }
  return { ...value, inspection };
}
