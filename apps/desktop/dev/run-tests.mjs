import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dirname, "..");
const environment = { ...process.env };
const directory = await mkdtemp(join(tmpdir(), "spool-web-suite-"));
try {
  const start = performance.now();
  await build({ root, build: { outDir: directory, emptyOutDir: true }, logLevel: "error" });
  console.log(`Built the shared browser client once in ${Math.round(performance.now() - start)}ms.`);
  const files = process.argv.slice(2);
  const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...(files.length ? files : ["dev/*.test.mjs"])], {
    cwd: root, stdio: "inherit", windowsHide: true,
    env: { ...environment, SPOOL_TEST_CLIENT_DIRECTORY: directory },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
