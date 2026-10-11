import { readFile } from "node:fs/promises";
import { paperclipJson, serializePaperclipJson } from "./creator-review.mjs";

const { PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID, PAPERCLIP_TASK_ID } = process.env;
if (!PAPERCLIP_API_URL || !PAPERCLIP_API_KEY || !PAPERCLIP_RUN_ID || !PAPERCLIP_TASK_ID || !process.argv[2]) {
  throw new Error("Requires a result JSON file and the agent's scoped Paperclip environment");
}
const config = { paperclipApiUrl: PAPERCLIP_API_URL.replace(/\/api\/?$/, "").replace(/\/$/, "") };
const headers = { authorization: `Bearer ${PAPERCLIP_API_KEY}`, "X-Paperclip-Run-Id": PAPERCLIP_RUN_ID };
const api = (route, options = {}) => paperclipJson(config, route, { ...options, headers });
const issuePath = `/issues/${PAPERCLIP_TASK_ID}`;
const result = JSON.parse(await readFile(process.argv[2], "utf8"));
const contractDocument = await api(`${issuePath}/documents/pr-review-contract`);
const contract = JSON.parse(contractDocument.body);
if (result.submissionId !== contract.submissionId || !/^[a-f0-9]{40}$/i.test(result.head || "") || !Array.isArray(result.findings)) {
  throw new Error("Result must match the active submission and contain the full pushed SHA and finding dispositions");
}
if (contract.version >= 2 && result.fingerprint !== contract.fingerprint) {
  throw new Error("New feedback changed the review contract; read the latest contract and address it before publishing");
}
const documents = await api(`${issuePath}/documents`);
const previous = documents.some((document) => document.key === "pr-update-result")
  ? await api(`${issuePath}/documents/pr-update-result`) : null;
const body = serializePaperclipJson(result);
const saved = await api(`${issuePath}/documents/pr-update-result`, {
  method: "PUT", body: JSON.stringify({
    title: `PR ${contract.prId} review result`, format: "markdown", body,
    baseRevisionId: previous?.latestRevisionId || null,
  }),
});
if (saved.body !== body) throw new Error("Paperclip did not preserve the result document");
console.log(`Recorded ${saved.key} revision ${saved.latestRevisionNumber}; completion is still independently checked by the dispatcher.`);
