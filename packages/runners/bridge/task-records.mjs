import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const priority = { incoming: 3, in_progress: 4, completed: 2, failed: 1 };
// Follow the daemon's move direction so incoming -> in_progress cannot vanish during enumeration.
export const queueStates = Object.freeze(Object.keys(priority));
const missing = Symbol("missing task");

export const safeId = value => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) throw new Error("Invalid Spool task id");
  return value;
};

export function readJson(file, absent = null) {
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return absent;
      if (!(error instanceof SyntaxError) || attempt === 12) throw new Error(`Cannot read ${file}: ${error.message}`);
      // The current Spool daemon rewrites task JSON in place. Never accept a partial read.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function readTaskRecord(file, state) {
  const task = readJson(file, missing);
  if (task === missing) return null;
  if (!task || `${safeId(task.id)}.json` !== path.basename(file) || typeof task.agent !== "string" ||
      typeof task.prompt !== "string") throw new Error(`Invalid Spool task: ${file}`);
  return { ...task, status: state, file };
}

function preferredTask(current, candidate) {
  return candidate && (!current || priority[candidate.status] > priority[current.status]) ? candidate : current;
}

export function readQueuedTasks(queues) {
  const tasks = new Map();
  for (const state of queueStates) {
    const folder = path.join(queues, state);
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(".json")) continue;
      const task = readTaskRecord(path.join(folder, name), state);
      if (!task) continue;
      tasks.set(task.id, preferredTask(tasks.get(task.id), task));
    }
  }
  return [...tasks.values()];
}

export function readQueuedTask(queues, id) {
  safeId(id);
  let task = null;
  for (const state of queueStates) {
    task = preferredTask(task, readTaskRecord(path.join(queues, state, `${id}.json`), state));
  }
  return task;
}
