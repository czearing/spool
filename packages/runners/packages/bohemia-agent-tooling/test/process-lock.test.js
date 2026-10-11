import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { acquireProcessLock } from "../src/process-lock.js";

test("a held process lock excludes contenders and becomes available after release", async () => {
  const resource = randomUUID();
  const release = await acquireProcessLock(resource);
  await assert.rejects(acquireProcessLock(resource), { code: "EADDRINUSE" });
  await assert.rejects(acquireProcessLock(resource, { timeoutMs: 20 }), { code: "RESOURCE_LOCK_TIMEOUT" });
  await release();
  await (await acquireProcessLock(resource))();
});

test("an exited holder cannot leave a PID-file lease that strands the next process", async () => {
  const resource = randomUUID();
  const script = `import { acquireProcessLock } from ${JSON.stringify(new URL("../src/process-lock.js", import.meta.url).href)};
    await acquireProcessLock(${JSON.stringify(resource)}); process.stdout.write("owned\\n"); process.exit(0);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true });
  let output = "", error = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => error += chunk);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, error);
  assert.match(output, /owned/);
  await (await acquireProcessLock(resource, { timeoutMs: 1000 }))();
});

test("many waiters serialize without leaking a lease", async () => {
  const resource = randomUUID();
  let owners = 0;
  await Promise.all(Array.from({ length: 30 }, async () => {
    const release = await acquireProcessLock(resource, { timeoutMs: 5000 });
    try {
      assert.equal(++owners, 1);
      await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(--owners, 0);
    } finally { await release(); }
  }));
});
