import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0").filter(Boolean);
const prohibited = /(^|\/)(agents|queues|controls|logs|usage|\.runner|\.runner-receipts|\.spool-ui|\.copilot|node_modules|\.local)(\/|$)|(^|\/)(connections|projects|spool-runners|spool)\.json$|(^|\/)\.env(?:\.|$)/;
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}|(?:AZURE_DEVOPS_EXT_PAT|GITHUB_TOKEN)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{20,}/;
const failures = [];
for (const file of files) {
  if (prohibited.test(file)) failures.push(`${file}: local runtime data must not be published`);
  const full = path.join(root, file);
  if (!fs.existsSync(full) || !/\.(?:[cm]?[jt]sx?|rs|json|ya?ml|toml|md|ps1|css|html)$/.test(file)) continue;
  const text = fs.readFileSync(full, "utf8");
  if (secret.test(text)) failures.push(`${file}: possible credential`);
  if (file.startsWith("desktop/") && !file.includes("pnpm-lock") && !file.endsWith(".md") && text.split("\n").length > 200) {
    failures.push(`${file}: handwritten file exceeds 200 lines`);
  }
}
if (failures.length) throw new Error(failures.join("\n"));
console.log(`Publication guard passed for ${files.length} source files.`);
