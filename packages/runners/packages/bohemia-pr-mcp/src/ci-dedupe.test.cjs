const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runDedupeDiagnostics } = require("./ci-dedupe.cjs");

test("Windows launcher preserves repository diagnostics, check arguments and failure status", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia-dedupe-"));
  try {
    fs.mkdirSync(path.join(root, "common", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      scripts: { "dedupe:diagnostics": "node common/scripts/pnpmDedupeDiagnostics.cjs" }
    }));
    fs.writeFileSync(path.join(root, "common", "scripts", "pnpmDedupeDiagnostics.cjs"), `
      exports.runDiagnostics = (args, spawn) => {
        const result = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["dedupe", ...args],
          { env: { NODE_OPTIONS: "fixture-preload" }, stdio: "inherit" });
        if (result.error) throw result.error;
        return result.status ?? 1;
      };
    `);
    assert.equal(runDedupeDiagnostics(root, (command, args, options) => {
      assert.equal(command, process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "pnpm");
      assert.deepEqual(args, process.platform === "win32"
        ? ["/d", "/s", "/c", "pnpm.cmd", "dedupe", "--check"] : ["dedupe", "--check"]);
      assert.deepEqual(options.env, { NODE_OPTIONS: "fixture-preload" });
      assert.equal(options.stdio, "inherit");
      assert.equal(options.cwd, root);
      assert.equal(options.shell, undefined);
      return { status: 7 };
    }), 7);
    assert.equal(runDedupeDiagnostics(root, () => ({ status: 0 })), 0);
    assert.throws(() => runDedupeDiagnostics(root, () => ({ error: new Error("spawn failure") })), /spawn failure/);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      scripts: { "dedupe:diagnostics": "node another-check.cjs" }
    }));
    assert.throws(() => runDedupeDiagnostics(root), /Unsupported dedupe diagnostics script/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real Windows shim runs unchanged checkout diagnostics and returns nonzero status", {
  skip: process.platform !== "win32"
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia dedupe "));
  try {
    fs.mkdirSync(path.join(root, "common", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      scripts: { "dedupe:diagnostics": "node common/scripts/pnpmDedupeDiagnostics.cjs" }
    }));
    const diagnostics = path.join(root, "common", "scripts", "pnpmDedupeDiagnostics.cjs");
    const contents = `exports.runDiagnostics = (args, spawn) => {
      const result = spawn("pnpm.cmd", ["dedupe", ...args], {
        env: { ...process.env, PNPM_NETWORK_DIAGNOSTICS_PRELOAD: "1" }, stdio: "inherit"
      });
      if (result.error) throw result.error;
      return result.status ?? 1;
    };`;
    fs.writeFileSync(diagnostics, contents);
    const fixture = path.join(root, "fixture.cjs");
    fs.writeFileSync(fixture, `console.log(JSON.stringify({
      args: process.argv.slice(2), preload: process.env.PNPM_NETWORK_DIAGNOSTICS_PRELOAD
    })); process.exitCode = Number(process.env.FIXTURE_EXIT);`);
    fs.writeFileSync(path.join(root, "pnpm.cmd"), `@"${process.execPath}" "${fixture}" %*\r\n`);
    const env = { ...process.env };
    const key = Object.keys(env).find(name => name.toLowerCase() === "path") || "PATH";
    env[key] = `${root}${path.delimiter}${env[key] || ""}`;
    for (const status of [0, 7]) {
      const result = spawnSync(process.execPath, [path.join(__dirname, "ci-dedupe.cjs"), root], {
        cwd: root, env: { ...env, FIXTURE_EXIT: String(status) }, encoding: "utf8"
      });
      assert.equal(result.error, undefined);
      assert.equal(result.stderr, "");
      assert.equal(result.status, status);
      assert.deepEqual(JSON.parse(result.stdout), { args: ["dedupe", "--check"], preload: "1" });
      assert.equal(fs.readFileSync(diagnostics, "utf8"), contents);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
