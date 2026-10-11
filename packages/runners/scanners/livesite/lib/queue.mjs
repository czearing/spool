import { createPaperclipQueue } from "../../../packages/bohemia-agent-tooling/src/index.js";

export function queueCredentials(environment = process.env) {
  const baseUrl = environment.PAPERCLIP_API_URL || "http://127.0.0.1:3400";
  const apiKey = environment.PAPERCLIP_API_KEY || "";
  const companyId = environment.PAPERCLIP_COMPANY_ID || "b15271fe-75c2-4273-b08e-08c41b2101c2";
  return { baseUrl, apiKey, companyId, runId: environment.PAPERCLIP_RUN_ID || null };
}

export function createQueue(config = {}, environment = process.env) {
  const credentials = queueCredentials(environment);
  return createPaperclipQueue({
    baseUrl: credentials.baseUrl,
    apiKey: credentials.apiKey,
    companyId: credentials.companyId,
    runId: credentials.runId,
    ...(config.queueOptions || {}),
  });
}
