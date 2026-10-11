import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validId } from "./workflow-schema.mjs";

export function ensureRunnerEntry(runtime, id) {
  if (!validId(id)) throw new Error("Invalid runner identity.");
  const directory = path.join(runtime, "runners", id), file = path.join(directory, "run.mjs");
  const entry = `import { runCustom } from ${JSON.stringify(new URL("./custom-run.mjs", import.meta.url).href)};\nawait runCustom(${JSON.stringify(id)}, import.meta.url);\n`;
  if (existsSync(file)) {
    const current = readFileSync(file, "utf8");
    if (current === entry) return;
    if (!/^import \{ (?:runCustom|run) \} from "[^"\r\n]+";(?:\r?\n)+await (?:runCustom|run)\("[a-z][a-z0-9-]*", import\.meta\.url\);\r?\n?$/.test(current))
      throw Object.assign(new Error("Runner entry already exists and is not editor-managed."), { status: 409 });
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, entry, "utf8");
}
