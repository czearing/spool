import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, rm } from "node:fs/promises";
import { hasCode } from "./file-snapshot";

export async function readOptionalJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(/* turbopackIgnore: true */ file, "utf8")); }
  catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
}
export async function publishJson(file: string, value: unknown, replace = false) {
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    if (replace) await rename(temporary, file); else await link(temporary, file);
  } finally {
    try { await rm(temporary, { force: true }); }
    catch (error) { console.error(`Could not remove temporary task file ${temporary}.`, error); }
  }
}
