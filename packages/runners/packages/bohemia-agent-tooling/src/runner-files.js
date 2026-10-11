import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export function readRunnerJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read runner record ${file}: ${error.message}`, { cause: error });
  }
}

export function writeRunnerJson(file, value) {
  writeRunnerText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeRunnerText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, "utf8");
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, file);
        break;
      } catch (error) {
        if (!["EPERM", "EBUSY"].includes(error.code) || attempt === 9) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function writeRunnerJsonAsync(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, file);
        return;
      } catch (error) {
        if (!["EPERM", "EBUSY"].includes(error.code) || attempt === 9) throw error;
        await delay(25 * (attempt + 1));
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export function runnerError(status) {
  return status?.lastError || status?.error || status?.blocked?.error || null;
}
