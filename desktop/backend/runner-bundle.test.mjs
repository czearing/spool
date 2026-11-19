import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRunners, verifyRunners } from "../scripts/build-runners.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "runner-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), target = path.join(root, "bundle");
  const write = async (relative, text = "") => {
    const file = path.join(source, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await mkdir(path.join(source, "node_modules", "harper.js"), { recursive: true });
  await mkdir(path.join(source, "scanners"));
  await write("package.json", '{"type":"module"}');
  await write("bridge/run.mjs", 'export const ready = true;');
  for (const relative of ["index.mjs", "worker.mjs", "errors.mjs", "codespaces/copilot.mjs",
    "codespaces/application.mjs", "codespaces/application-browser.mjs", "codespaces/application-vm.mjs",
    "codespaces/application-auth-source.mjs", "codespaces/application-broker.mjs",
    "codespaces/deployed-browser.mjs", "codespaces/deployed-sign-in.mjs", "codespaces/deployed-vm.mjs",
    "codespaces/figma-fetch.mjs", "codespaces/creator-review.mjs", "codespaces/creator-resolver.mjs",
    "codespaces/connector/src/connect.ts", "codespaces/connector/src/agentsAuth.ts"])
    await write(path.join("packages", "repository-mcp", "src", relative));
  return { source, target, write };
}

test("incomplete MCP packaging cannot remove a working bundle", async t => {
  const f = await fixture(t);
  await mkdir(f.target);
  await writeFile(path.join(f.target, "working"), "preserved");
  await rm(path.join(f.source, "packages", "repository-mcp", "src", "codespaces", "connector"), { recursive: true });
  await assert.rejects(buildRunners(f), /Incomplete repository MCP bundle/);
  assert.equal(await readFile(path.join(f.target, "working"), "utf8"), "preserved");
});

test("one complete bundle includes default connectors and a verified source manifest", async t => {
  const f = await fixture(t);
  await f.write("packages/repository-mcp/src/unused.test.mjs", "throw Error('not runtime');");
  await f.write("bridge/help.ps1", 'Join-Path $PSScriptRoot "./browser-runtime.mjs"');
  await f.write("bridge/browser-runtime.mjs", "export const ready = true;");
  await buildRunners(f);
  const manifest = JSON.parse(await readFile(path.join(f.target, "runtime-manifest.json"), "utf8"));
  assert.deepEqual(manifest.files, await verifyRunners(f.target));
  assert.ok(manifest.files["packages/repository-mcp/src/codespaces/connector/src/connect.ts"]);
  assert.ok(manifest.files["packages/repository-mcp/src/codespaces/deployed-vm.mjs"]);
  assert.ok(manifest.files["bridge/browser-runtime.mjs"]);
  assert.ok(!manifest.files["packages/repository-mcp/src/unused.test.mjs"]);
});

test("missing VM sign-in support cannot ship an incomplete runtime", async t => {
  const f = await fixture(t);
  await rm(path.join(f.source, "packages", "repository-mcp", "src", "codespaces", "deployed-vm.mjs"));
  await assert.rejects(verifyRunners(f.source), /Incomplete repository MCP bundle: src\/codespaces\/deployed-vm.mjs/);
});

test("missing unattended application renewal cannot ship an incomplete runtime", async t => {
  const f = await fixture(t);
  await rm(path.join(f.source, "packages", "repository-mcp", "src", "codespaces", "application-vm.mjs"));
  await assert.rejects(verifyRunners(f.source), /Incomplete repository MCP bundle: src\/codespaces\/application-vm.mjs/);
});

test("missing transitive imports fail before replacing a working bundle", async t => {
  const f = await fixture(t);
  await mkdir(f.target);
  await writeFile(path.join(f.target, "working"), "preserved");
  await f.write("packages/repository-mcp/src/worker.mjs", 'import "./missing.mjs";');
  await assert.rejects(buildRunners(f), /Missing runner module/);
  assert.equal(await readFile(path.join(f.target, "working"), "utf8"), "preserved");
});

test("incompatible ACP exports fail before replacing a working bundle", async t => {
  const f = await fixture(t);
  await mkdir(f.target);
  await writeFile(path.join(f.target, "working"), "preserved");
  await f.write("packages/repository-mcp/src/codespaces/policy.mjs", "export const unrelated = true;");
  await f.write("packages/repository-mcp/src/codespaces/copilot.mjs",
    'import { descriptionFields } from "./policy.mjs"; export { descriptionFields };');
  await assert.rejects(buildRunners(f), /does not provide an export named 'descriptionFields'/);
  assert.equal(await readFile(path.join(f.target, "working"), "utf8"), "preserved");
});

test("missing PowerShell runtime helpers fail before replacing a working bundle", async t => {
  const f = await fixture(t);
  await mkdir(f.target);
  await writeFile(path.join(f.target, "working"), "preserved");
  await f.write("bridge/help.ps1", 'Join-Path $PSScriptRoot "./browser-runtime.mjs"');
  await assert.rejects(buildRunners(f), /Missing runner module: .*help\.ps1 -> \.\/browser-runtime\.mjs/);
  assert.equal(await readFile(path.join(f.target, "working"), "utf8"), "preserved");
});

test("changed runtime content identifies the file and preserves the working bundle", async t => {
  const f = await fixture(t);
  await mkdir(f.target);
  await writeFile(path.join(f.target, "working"), "preserved");
  await f.write("packages/repository-mcp/src/codespaces/copilot.mjs",
    'import { writeFileSync } from "node:fs"; ' +
    'writeFileSync(new URL("../../../../bridge/run.mjs", import.meta.url), "export const ready = false;");');
  await assert.rejects(buildRunners(f), /content differs from source: bridge\/run\.mjs/);
  assert.equal(await readFile(path.join(f.target, "working"), "utf8"), "preserved");
});
