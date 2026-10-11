import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVES = 7;

export function createActivityLog(runtime, options = {}) {
  const file = path.join(runtime, "activity.jsonl");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxArchives = options.maxArchives ?? DEFAULT_MAX_ARCHIVES;
  return async (event, details = {}) => {
    const record = { timestamp: new Date().toISOString(), event, ...details };
    const line = `${JSON.stringify(record)}\n`;
    await mkdir(runtime, { recursive: true });
    await rotateIfNeeded(file, runtime, Buffer.byteLength(line), maxBytes, maxArchives);
    await appendFile(file, line, "utf8");
    console.log(formatRecord(record));
  };
}

export function formatRecord(record) {
  const details = Object.entries(record)
    .filter(([key, value]) => key !== "timestamp" && key !== "event" && value != null)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
  return `${record.timestamp} [${record.event}]${details ? ` ${details}` : ""}`;
}

async function rotateIfNeeded(file, runtime, incomingBytes, maxBytes, maxArchives) {
  const size = await stat(file).then((value) => value.size).catch((error) => {
    if (error.code === "ENOENT") return 0;
    throw error;
  });
  if (size + incomingBytes <= maxBytes) return;
  const content = await readFile(file, "utf8");
  await updateRollups(runtime, content);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  await rename(file, path.join(runtime, `activity-${stamp}.jsonl`));
  const archives = (await readdir(runtime))
    .filter((name) => /^activity-.*\.jsonl$/.test(name))
    .sort()
    .reverse();
  await Promise.all(archives.slice(maxArchives).map((name) => rm(path.join(runtime, name))));
}

async function updateRollups(runtime, content) {
  const file = path.join(runtime, "activity-rollups.json");
  const rollups = await readFile(file, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return { days: {} };
      throw error;
    });
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const day = String(record.timestamp || "").slice(0, 10);
    if (!day || !record.event) continue;
    rollups.days[day] ??= { events: {}, firstAt: record.timestamp, lastAt: record.timestamp };
    const value = rollups.days[day];
    value.events[record.event] = (value.events[record.event] || 0) + 1;
    if (record.timestamp < value.firstAt) value.firstAt = record.timestamp;
    if (record.timestamp > value.lastAt) value.lastAt = record.timestamp;
  }
  await writeFile(file, `${JSON.stringify(rollups, null, 2)}\n`, "utf8");
}

function formatValue(value) {
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  return /\s/.test(text) ? JSON.stringify(text) : text;
}
