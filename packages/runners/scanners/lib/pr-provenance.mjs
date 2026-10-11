import { createHash } from "node:crypto";
import { productMatchesPr } from "./creator-review.mjs";

// This is a reviewed attribution registry, not an execution allowlist.
export async function resolveProvenance(registry, { config, api, agents, previous = {} }) {
  if (registry.version !== 1 || !Array.isArray(registry.records)) throw new Error("Invalid PR creator provenance registry");
  const records = registry.records.filter((record) => record.companyId === config.paperclipCompanyId &&
    productMatchesPr({ type: "pull_request", url: record.prUrl }, {
      url: `${config.organization}/${encodeURIComponent(config.project)}/_git/${encodeURIComponent(config.repository)}/pullrequest/${record.prId}`,
    }));
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.prId)) throw new Error(`PR ${record.prId}: ambiguous creator provenance`);
    ids.add(record.prId);
    if (record.originKind === "copilot_cli") {
      if (!/^\d+$/.test(record.prId) || !record.branch || !record.sourceSessionId ||
          !record.evidence || !Number.isFinite(Date.parse(record.verifiedAt)) ||
          record.issueId || record.agentId || record.creationRunId) {
        throw new Error(`PR ${record.prId}: invalid external CLI provenance`);
      }
      continue;
    }
    if (!/^\d+$/.test(record.prId) || !record.issueId || !record.identifier || !record.agentId ||
        !record.creationRunId || !record.branch || !record.evidence || !Number.isFinite(Date.parse(record.verifiedAt))) {
      throw new Error(`PR ${record.prId}: incomplete creator provenance`);
    }
  }
  const base = (config.paperclipUiUrl || config.paperclipApiUrl).replace(/\/$/, "");
  const entries = await Promise.all(records.map(async (record) => {
    const sourceKey = createHash("sha256").update(JSON.stringify([record, config.paperclipApiUrl, base])).digest("hex");
    if (record.originKind === "copilot_cli") {
      return [record.prId, { ...record, sourceKey, agentName: "Copilot CLI (external)", verified: true }];
    }
    const agent = agents.find((entry) => entry.id === record.agentId);
    if (!agent || agent.companyId !== record.companyId) throw new Error(`PR ${record.prId}: creator agent/company mismatch`);
    if (previous[record.prId]?.sourceKey === sourceKey) {
      return [record.prId, { ...previous[record.prId], agentName: agent.name }];
    }
    const [issue, run] = await Promise.all([
      api(`/issues/${record.issueId}`), api(`/heartbeat-runs/${record.creationRunId}`),
    ]);
    if (issue.id !== record.issueId || issue.identifier !== record.identifier || issue.companyId !== record.companyId ||
        run.id !== record.creationRunId || run.companyId !== record.companyId ||
        run.contextSnapshot?.issueId !== issue.id || run.agentId !== record.agentId) {
      throw new Error(`PR ${record.prId}: originating issue/run provenance mismatch`);
    }
    const prefix = issue.identifier.split("-")[0];
    return [record.prId, {
      ...record, sourceKey, agentName: agent.name, verified: true,
      issueUrl: `${base}/${prefix}/issues/${issue.identifier}`,
      runUrl: `${base}/${prefix}/agents/${run.agentId}/runs/${run.id}`,
    }];
  }));
  return Object.fromEntries(entries);
}
