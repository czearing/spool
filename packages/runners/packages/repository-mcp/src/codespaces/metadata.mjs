import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertReviewCoverage } from "./config.mjs";
import { packageIdentity } from "../adapters/1js-packages.mjs";

export function readBatchBlobs(buffer, count) {
  let offset = 0;
  const result = [];
  for (let index = 0; index < count; index++) {
    const end = buffer.indexOf(10, offset);
    if (end < 0) throw new Error("Incomplete Git metadata response");
    const header = buffer.subarray(offset, end).toString("utf8");
    offset = end + 1;
    if (header.endsWith(" missing")) { result.push(null); continue; }
    const match = /^[a-f0-9]{40} blob (\d+)$/.exec(header);
    if (!match) throw new Error(`Unexpected Git metadata response: ${header}`);
    const size = Number(match[1]);
    if (offset + size >= buffer.length || buffer[offset + size] !== 10)
      throw new Error("Truncated Git metadata blob");
    result.push(buffer.subarray(offset, offset + size));
    offset += size + 1;
  }
  if (offset !== buffer.length) throw new Error("Extra Git metadata response");
  return result;
}

export function reviewSourcePackageNames(root, files, env) {
  assertReviewCoverage(files);
  const requests = new Set();
  const candidates = files.map(file => {
    if (/^midgard\/change\/[^/]+\.json$/.test(file)) {
      requests.add(file);
      return { file, changefile: true };
    }
    const manifests = [];
    let directory = path.posix.dirname(file);
    while (![".", "midgard", "packages"].includes(directory)) {
      manifests.push(`${directory}/package.json`);
      requests.add(manifests.at(-1));
      directory = path.posix.dirname(directory);
    }
    if (!manifests.length)
      throw new Error(`Root/infrastructure change needs an explicit scoped validation plan: ${file}`);
    return { file, manifests };
  });
  const paths = [...requests];
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root, env, input: paths.map(file => `HEAD:${file}`).join("\n") + "\n",
    maxBuffer: 64 * 1024 * 1024, timeout: 120000,
  });
  const blobs = readBatchBlobs(output, paths.length);
  const committed = new Map(paths.map((file, index) => [file, blobs[index]]));
  const names = new Set();
  const include = (name, file) => {
    if (!packageIdentity.test(name || ""))
      throw new Error(`Changed package has an unsupported committed identity: ${file}`);
    names.add(name);
  };
  for (const entry of candidates) {
    if (entry.changefile) {
      const blob = committed.get(entry.file);
      if (!blob) continue;
      const change = JSON.parse(blob);
      if (!Array.isArray(change.changes)) throw new Error(`Invalid changefile: ${entry.file}`);
      for (const item of change.changes) include(item.packageName, entry.file);
    } else {
      const file = entry.manifests.find(candidate => committed.get(candidate));
      if (!file) throw new Error(`Root/infrastructure change needs an explicit scoped validation plan: ${entry.file}`);
      include(JSON.parse(committed.get(file)).name, file);
    }
  }
  return [...names].sort();
}
