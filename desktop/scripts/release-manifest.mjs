import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [directory, tag, repository] = process.argv.slice(2);
if (!directory || !/^v\d+\.\d+\.\d+$/.test(tag) || !/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw new Error("Provide an artifact directory, release tag and owner/repository.");
const files = (await readdir(directory)).filter(name => name.endsWith(".exe"));
if (files.length !== 1 || !files[0].includes(`_${tag.slice(1)}_`))
  throw new Error("Release must contain exactly one installer matching the release version.");
const signature = (await readFile(path.join(directory, `${files[0]}.sig`), "utf8")).trim();
if (!signature) throw new Error("Release installer signature is missing.");
await writeFile(path.join(directory, "latest.json"), JSON.stringify({
  version: tag.slice(1), pub_date: new Date().toISOString(),
  platforms: { "windows-x86_64": {
    signature, url: `https://github.com/${repository}/releases/download/${tag}/${files[0]}`,
  } },
}, null, 2) + "\n");
