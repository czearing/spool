import { readdirSync } from "node:fs";
import path from "node:path";
import { digest, readJson, samePath } from "./spool-store.mjs";

export function readCreatorResult(store, task, key) {
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

export function creatorResultHistory(store) {
  // Scope discovery to one operation; result reads still check the live receipt.
  let indices;
  const histories = new Map();
  return task => {
    if (!indices) {
      let files;
      try { files = readdirSync(store.records); }
      catch (error) { if (error.code !== "ENOENT") throw error; files = []; }
      indices = files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))
        .map(name => readJson(path.join(store.records, name)))
        .filter(index => typeof index?.key === "string");
    }
    if (!histories.has(task.id)) histories.set(task.id, indices.filter(index => index.taskId === task.id).map(index => {
      if (!index.nativeMessageId) return index;
      try { return store.receipt(index.key) || index; }
      catch { return index; }
    }).filter(receipt => (receipt.phase === "published" && receipt.contract) ||
      (receipt.nativeMessageId && !receipt.phase))
      .sort((a, b) => (b.contract?.at || "").localeCompare(a.contract?.at || ""))
      .map(receipt => receipt.key));
    return [...histories.get(task.id)];
  };
}
