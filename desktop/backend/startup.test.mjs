import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { build } from "esbuild";
import { routeSource } from "./route-source.ts";

for (const failed of [false, true])
test(`backend stays independent when runner service startup ${failed ? "fails" : "is pending"}`, { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-startup-"));
  const resources = join(root, "resources"), bridge = join(resources, "runners", "bridge");
  await mkdir(bridge, { recursive: true });
  await writeFile(join(root, "projects.json"), '{"version":1,"projects":[]}');
  await writeFile(join(bridge, "application-service.mjs"), `
    import { existsSync, writeFileSync } from "node:fs";
    import { dirname, join } from "node:path";
    import { setTimeout } from "node:timers/promises";
    export async function startRunnerService(registry) {
      const root = dirname(registry);
      writeFileSync(join(root, "starting"), "");
      ${failed ? 'throw new Error("Fixture runner startup failed");' : `
      while (!existsSync(join(root, "release"))) await setTimeout(10);
      return { stop: async () => { writeFileSync(join(root, "stopped"), ""); } };`}
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
  const service = spawn(process.execPath, [file, "--runner-service"], { cwd: root, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  service.stderr.on("data", chunk => { stderr += chunk; });
  const serviceExit = once(service, "exit");
  const child = spawn(process.execPath, [file], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit"), frames = [];
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => frames.push(JSON.parse(line)));
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Backend did not respond: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  t.after(async () => {
    child.stdin.end(); await exited;
    await writeFile(join(root, "release"), "");
    if (!failed) service.stdin.write("shutdown\n");
    await serviceExit;
    await rm(root, { recursive: true, force: true });
  });
  await until(() => frames.some(frame => frame.id === "ready") && existsSync(join(root, "starting")));
  child.stdin.write(JSON.stringify({ id: "page", method: "GET", url: "/api/desktop/page" }) + "\n");
  await until(() => frames.some(frame => frame.id === "page" && frame.type === "end"));
  assert.equal(frames.find(frame => frame.id === "page" && frame.type === "head").status, 200);
  child.stdin.end();
  assert.equal((await exited)[0], 0);
  if (failed) {
    assert.notEqual((await serviceExit)[0], 0);
    assert.match(stderr, /Fixture runner startup failed/);
  } else {
    assert.equal(service.exitCode, null, "Closing the UI backend must not stop runner startup.");
    assert.equal(existsSync(join(root, "stopped")), false);
  }
});
