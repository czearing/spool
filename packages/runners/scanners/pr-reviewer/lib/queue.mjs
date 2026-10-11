import fs from "node:fs";
import { createPaperclipQueue } from "../../../packages/bohemia-agent-tooling/src/index.js";

const DEFAULT_CREDENTIAL_PATH = "C:\\Agent Logs\\Bohemia-Agent-Tooling-Engineer\\runners.env";

function loadEnvFromFile(filePath = DEFAULT_CREDENTIAL_PATH) {
  const loaded = {};
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      loaded[key] = val;
    }
  }
  return loaded;
}

/**
 * The queue this runner writes to and reads from.
 *
 * Credentials are read from the environment, credential file, or configuration.
 */
export function queueCredentials(environment = process.env, config = {}, credentialFile = DEFAULT_CREDENTIAL_PATH) {
  const fileEnv = credentialFile ? loadEnvFromFile(credentialFile) : {};
  const baseUrl = environment.PAPERCLIP_API_URL || fileEnv.PAPERCLIP_API_URL || config.paperclipApiUrl;
  const apiKey = environment.PAPERCLIP_API_KEY || fileEnv.PAPERCLIP_API_KEY || config.paperclipApiKey || "";
  const companyId = environment.PAPERCLIP_COMPANY_ID || fileEnv.PAPERCLIP_COMPANY_ID || config.paperclipCompanyId;
  const missing = [
    ...(baseUrl ? [] : ["PAPERCLIP_API_URL"]),
    ...(companyId ? [] : ["PAPERCLIP_COMPANY_ID"]),
  ];
  return { baseUrl, apiKey, companyId, runId: environment.PAPERCLIP_RUN_ID || null, missing };
}

export function createQueue(config = {}, environment = process.env, credentialFile = DEFAULT_CREDENTIAL_PATH) {
  const credentials = queueCredentials(environment, config, credentialFile);
  if (credentials.missing.length > 0) {
    throw new Error(`the queue is unreachable without ${credentials.missing.join(", ")}`);
  }
  return createPaperclipQueue({
    baseUrl: credentials.baseUrl,
    apiKey: credentials.apiKey,
    companyId: credentials.companyId,
    runId: credentials.runId,
    ...(config.queueOptions || {}),
  });
}

export async function reviewerIsBusy(config, fetchImpl = fetch, credentials = queueCredentials(process.env, config)) {
  if (credentials.missing.length) throw new Error(`Missing ${credentials.missing.join(", ")}`);
  const base = credentials.baseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
  const headers = credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {};
  const response = await fetchImpl(`${base}/api/companies/${credentials.companyId}/live-runs`, {
    headers, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Reviewer liveness check failed: HTTP ${response.status}`);
  const runs = await response.json();
  if (!Array.isArray(runs)) throw new Error("Invalid Paperclip live-runs response");
  return runs.some((run) => run.agentId === config.agentId && ["queued", "running"].includes(run.status));
}
