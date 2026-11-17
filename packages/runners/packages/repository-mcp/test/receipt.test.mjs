import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { execute, writeReceipt } from "../src/process.mjs";

test("Windows command processor runs when the application PATH omits System32",
  { skip: process.platform !== "win32" }, async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
    env.PATH = os.tmpdir();
    const { stdout } = await execute("cmd.exe", ["/d", "/c", "echo", "command-processor-ready"], { env });
    assert.equal(stdout.trim(), "command-processor-ready");
  });

function fixture(t, rename) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-receipt-"));
  const file = path.join(root, "preparation.json");
  const original = fs.renameSync;
  fs.writeFileSync(file, '{"ready":false}\n');
  t.mock.method(fs, "renameSync", (...args) => rename(original, ...args));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file };
}

test("transient Windows receipt locks retry atomically and preserve the JSON format", t => {
  let attempts = 0;
  const { root, file } = fixture(t, (rename, from, to) => {
    attempts++;
    assert.equal(fs.readFileSync(to, "utf8"), '{"ready":false}\n');
    if (attempts <= 2) throw Object.assign(Error("Receipt temporarily open"), {
      code: attempts === 1 ? "EPERM" : "EBUSY",
    });
    return rename(from, to);
  });
  writeReceipt(file, { ready: true, commit: "a".repeat(40) });
  assert.equal(attempts, 3);
  assert.equal(fs.readFileSync(file, "utf8"), `${JSON.stringify({ ready: true, commit: "a".repeat(40) }, null, 2)}\n`);
  assert.deepEqual(fs.readdirSync(root), ["preparation.json"]);
});

for (const [code, expectedAttempts] of [["EACCES", 1], ["EPERM", 10]]) {
  test(`persistent ${code} fails without replacing the prior receipt or leaving partial files`, t => {
    let attempts = 0;
    const { root, file } = fixture(t, () => {
      attempts++;
      throw Object.assign(Error("Receipt unavailable"), { code });
    });
    assert.throws(() => writeReceipt(file, { ready: true }), error => error.code === code);
    assert.equal(attempts, expectedAttempts);
    assert.equal(fs.readFileSync(file, "utf8"), '{"ready":false}\n');
    assert.deepEqual(fs.readdirSync(root), ["preparation.json"]);
  });
}
