import path from "node:path";
import { digest, readJson, samePath } from "./spool-store.mjs";

export const resultComment = text => text.startsWith("PR_UPDATE_RESULT:") || text.startsWith("PR_UPDATE_RESULT_FILE:");

export function readCreatorResult(store, task, text) {
  if (text.startsWith("PR_UPDATE_RESULT_FILE:")) {
    const key = text.slice("PR_UPDATE_RESULT_FILE:".length).trim();
    const receipt = store.receipt(key);
    if (receipt?.phase !== "published" || receipt.taskId !== task.id || !receipt.contract) {
      throw new Error("Result file does not belong to this published original-task submission");
    }
    const file = path.join(store.records, "results", `${digest(key)}.json`);
    if (receipt.contract.resultFile && !samePath(receipt.contract.resultFile, file)) {
      throw new Error("Result file contract points outside its canonical submission artifact");
    }
    const result = readJson(file);
    if (!result || result.submissionId !== key) throw new Error("Result artifact is missing or names another submission");
    return result;
  }
  if (!text.startsWith("PR_UPDATE_RESULT:")) throw new Error("Unrecognized creator-result transport");
  return JSON.parse(text.slice("PR_UPDATE_RESULT:".length).trim());
}
