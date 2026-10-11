import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

function progressPath(repoRoot, directory) {
  const root = path.resolve(repoRoot);
  const key = createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
  return path.join(directory, `${key}.json`);
}

export function installLogDirectory() {
  return path.join(os.homedir(), ".bohemia-gate", "install-logs");
}

export function writeInstallProgress(repoRoot, record, directory = installLogDirectory()) {
  fs.mkdirSync(directory, { recursive: true });
  const file = progressPath(repoRoot, directory);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record));
  fs.renameSync(temporary, file);
}

export function readLogTail(file, limit = 64 * 1024) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, limit));
    const count = fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.subarray(0, count).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function readInstallProgress(repoRoot, notBefore, directory = installLogDirectory()) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(progressPath(repoRoot, directory), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (record.state !== "running" || !Number.isFinite(record.startedAt) || record.startedAt < notBefore) return null;
  if (typeof record.logFile !== "string" || path.dirname(record.logFile) !== path.resolve(directory)) {
    throw new Error("Invalid install progress log path");
  }
  const counters = {};
  for (const line of readLogTail(record.logFile).split("\n")) {
    const text = line.trim();
    if (!text.startsWith("Progress: ")) continue;
    for (const field of text.slice("Progress: ".length).split(",")) {
      const [name, value] = field.trim().split(" ");
      if (["resolved", "reused", "downloaded", "added"].includes(name) && value !== undefined &&
          Number.isSafeInteger(Number(value)) && Number(value) >= 0) counters[name] = Number(value);
    }
  }
  return { seconds: Math.max(0, Math.round((Date.now() - record.startedAt) / 1000)),
    importMethod: record.importMethod, counters };
}

export function installProgressMessage(repoRoot, notBefore) {
  const install = readInstallProgress(repoRoot, notBefore);
  if (!install) return "";
  const counts = Object.entries(install.counters).map(([key, value]) => `${key}=${value}`).join(", ");
  return `; dependency install ${install.seconds}s, requested import=${install.importMethod}${counts ? `, ${counts}` : ""}`;
}
