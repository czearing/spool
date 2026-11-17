import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { build } from "esbuild";
import { routeSource } from "./route-source.ts";

for (const failed of [false, true])
test(`UI requests remain available while runner startup ${failed ? "fails" : "is pending"}`, { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-startup-"));
  const resources = join(root, "resources"), bridge = join(resources, "runners", "bridge");
  await mkdir(bridge, { recursive: true });
  await writeFile(join(root, "projects.json"), '{"version":1,"projects":[]}');
  await writeFile(join(bridge, "application.mjs"), `
    import { watch, existsSync, writeFileSync } from "node:fs";
    import { dirname, join } from "node:path";
    export async function startApplicationRunners(registry) {
      const root = dirname(registry);
      writeFileSync(join(root, "starting"), "");
      process.stdin.once("end", () => writeFileSync(join(root, "parent-closed"), ""));
      ${failed ? 'throw new Error("Fixture runner startup failed");' : `
      await new Promise(resolve => {
        const watcher = watch(root, () => {
          if (existsSync(join(root, "release"))) { watcher.close(); resolve(); }
        });
      });
      return { stop: async () => {
        await new Promise(resolve => setImmediate(resolve));
        writeFileSync(join(root, "stopped"), "");
      } };`}
    }
  `);
  const desktop = resolve(import.meta.dirname, ".."), file = join(resources, "backend.mjs");
  await build({
    entryPoints: [join(desktop, "backend", "main.ts")], bundle: true, platform: "node", format: "esm",
    target: "node24", outfile: file,
    banner: { js: 'import { createRequire as __startupCreateRequire } from "node:module"; const require = __startupCreateRequire(import.meta.url);' },
    plugins: [{ name: "startup-fixture-routes", setup(builder) {
      builder.onResolve({ filter: /^desktop:routes$/ }, () => ({ path: "routes", namespace: "desktop" }));
      builder.onLoad({ filter: /.*/, namespace: "desktop" }, async () => ({
        contents: await routeSource(), loader: "ts", resolveDir: desktop,
      }));
    } }],
  });
  const child = spawn(process.execPath, [file], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => {});
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => resolve(code));
  });
  const frames = [], listeners = new Set();
  const watcher = watch(root, () => { for (const listener of listeners) listener(); });
  t.after(async () => {
    child.stdin.end();
    await writeFile(join(root, "release"), "");
    await exited;
    watcher.close();
    await rm(root, { recursive: true, force: true });
  });
  createInterface({ input: child.stdout }).on("line", line => {
    frames.push(JSON.parse(line));
    for (const listener of listeners) listener();
  });
  const waitFor = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Backend did not respond: ${stderr}`)); }, 5000);
    const check = () => {
      if (!predicate()) return;
      clearTimeout(timer); listeners.delete(check); resolve();
    };
    listeners.add(check); check();
  });
  await waitFor(() => frames.some(frame => frame.id === "ready"));
  assert.equal(existsSync(join(root, "starting")), true);
  assert.equal(existsSync(join(root, "release")), false);
  if (!failed) child.stdin.write(JSON.stringify({
    id: "runner", method: "GET", url: "/api/projects/missing/runners",
  }) + "\n");
  child.stdin.write(JSON.stringify({ id: "page", method: "GET", url: "/api/desktop/page" }) + "\n");
  await waitFor(() => frames.some(frame => frame.id === "page" && frame.type === "end"));
  assert.equal(frames.find(frame => frame.id === "page" && frame.type === "head").status, 200);
  const body = frames.filter(frame => frame.id === "page" && frame.type === "chunk")
    .map(frame => Buffer.from(frame.body, "base64").toString()).join("");
  assert.deepEqual(JSON.parse(body).page, { kind: "setup" });
  if (!failed) assert.equal(frames.some(frame => frame.id === "runner"), false,
    "Runner operations must wait for initialization without blocking unrelated UI requests.");
  child.stdin.end();
  await waitFor(() => existsSync(join(root, "parent-closed")));
  assert.equal(existsSync(join(root, "stopped")), false);
  await writeFile(join(root, "release"), "");
  assert.equal(await exited, 0, stderr);
  if (failed) assert.match(stderr, /Fixture runner startup failed/);
  else assert.equal(await readFile(join(root, "stopped"), "utf8"), "", "Shutdown must drain startup before exiting.");
});
