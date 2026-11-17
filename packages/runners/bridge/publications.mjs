import path from "node:path";
import { readdirSync } from "node:fs";
import { publicationUrl, readPublication, readPublications } from "../packages/bohemia-agent-tooling/src/publications.js";
import { readJson, samePath } from "./spool-files.mjs";

const belongs = (store, record) => record?.projectRoot && samePath(record.projectRoot, store.root);
const identity = record => record?.prUrl ? publicationUrl(record.prUrl) : JSON.stringify(record);

function currentConversation(store, record) {
  if (!record?.deferred || record.sessionId != null) return record;
  const task = store.task(record.taskId);
  if (!task?.session_id) return record;
  const descriptor = readJson(path.join(store.root, "controls", "executions", `${task.id}.json`)) ||
    readJson(path.join(store.records, "creator-contexts", `${task.id}.json`));
  if (!(task.deferred_session || task.deferred_pr_owner) || task.agent !== record.agent ||
      descriptor?.taskId !== task.id || descriptor.agent !== task.agent || descriptor.sessionId !== task.session_id)
    throw new Error("Reserved publishing conversation does not match its saved execution identity");
  return { ...record, sessionId: task.session_id };
}

export function publicationsForProject(store, registry = readJson(path.join(store.records, "ownership.json"))) {
  if (registry && (registry.version !== 1 || !Array.isArray(registry.pullRequests)))
    throw new Error("Invalid historical publication registry");
  let historical = [];
  const directory = path.join(store.records, "native-creators");
  try {
    historical = readdirSync(directory).filter(name => name.endsWith(".json"))
      .map(name => readJson(path.join(directory, name)));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const publications = readPublications(store.publicationDirectory);
  const current = publications.filter(record => belongs(store, record));
  const recorded = new Set(publications.map(identity));
  return [...current, ...[...(registry?.pullRequests || []), ...historical].filter(record => !recorded.has(identity(record)))]
    .map(record => currentConversation(store, record));
}

export function publicationForTask(store, taskId, { prId, prUrl, branch } = {}) {
  const matches = record => record?.taskId === taskId &&
    (prId == null || String(record.prId) === String(prId)) &&
    (!prUrl || record.prUrl && publicationUrl(record.prUrl) === publicationUrl(prUrl)) &&
    (!branch || record.branch === branch);
  if (prUrl) {
    const record = readPublication(prUrl, store.publicationDirectory);
    if (record) return belongs(store, record) && matches(record) ? currentConversation(store, record) : null;
  }
  const records = readPublications(store.publicationDirectory).filter(record => belongs(store, record) && matches(record));
  if (records.length > 1) throw new Error("Publication lookup requires a PR or branch, not just a task");
  if (records.length === 1) return currentConversation(store, records[0]);
  const previous = readJson(path.join(store.records, "native-creators", `${taskId}.json`));
  if (previous?.prUrl) {
    const current = readPublication(previous.prUrl, store.publicationDirectory);
    if (current) return belongs(store, current) && matches(current) ? currentConversation(store, current) : null;
  }
  return matches(previous) ? currentConversation(store, previous) : null;
}

export function taskHasPublication(store, taskId) {
  return publicationsForProject(store).some(record => record.taskId === taskId);
}
