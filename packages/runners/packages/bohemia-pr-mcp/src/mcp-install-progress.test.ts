import "./test-environment.ts";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installLogDirectory, writeInstallProgress } from "./install-progress.mjs";

test("the production fresh worker reads install progress independently of tool execution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia-progress-worker-"));
  const directory = installLogDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const logFile = path.join(directory, "worker-fixture.log");
  fs.writeFileSync(logFile, "Progress: resolved 2, reused 2, downloaded 0, added 1\n");
  writeInstallProgress(root, { state: "running", startedAt: Date.now(), logFile, importMethod: "hardlink" });
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "worker.ts")], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env,
  });
  child.stdin.write(JSON.stringify({
    method: "internal/install-progress", params: { arguments: { repoRoot: root, notBefore: 0 } },
  }));
  child.stdin.end();
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code).toBe(0);
  expect(error).toBe("");
  expect(JSON.parse(output).detail).toContain("reused=2, downloaded=0, added=1");
  fs.rmdirSync(root);
});

test("the real MCP transport reports current installer cache counts before the tool finishes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia-progress-transport-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  for (const file of ["index.ts", "install-progress.mjs"]) {
    fs.copyFileSync(path.join(import.meta.dir, file), path.join(root, file));
  }
  fs.writeFileSync(path.join(root, "worker.ts"), `
    import fs from "node:fs";
    import path from "node:path";
    import { installLogDirectory, writeInstallProgress, installProgressMessage } from "./install-progress.mjs";
    const request = JSON.parse(await new Response(Bun.stdin.stream()).text());
    if (request.method === "internal/install-progress") {
      const { repoRoot, notBefore } = request.params.arguments;
      process.stdout.write(JSON.stringify({ detail: installProgressMessage(repoRoot, notBefore) }));
      process.exit(0);
    }
    const directory = installLogDirectory();
    fs.mkdirSync(directory, { recursive: true });
    const logFile = path.join(directory, "fixture.log");
    fs.writeFileSync(logFile, "Progress: resolved 3, reused 3, downloaded 0, added 2\\n");
    const record = { state: "running", startedAt: Date.now(), logFile, importMethod: "hardlink" };
    writeInstallProgress(request.params.arguments.repoRoot, record);
    await Bun.sleep(32000);
    writeInstallProgress(request.params.arguments.repoRoot, { ...record, state: "completed" });
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [] } }));
  `);
  const child = Bun.spawn([process.execPath, "run", path.join(root, "index.ts")], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, USERPROFILE: home, HOME: home },
  });
  const messages: { id?: number; method?: string; params?: { progressToken?: string; message?: string } }[] = [];
  const stderr = new Response(child.stderr).text();
  const reading = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        messages.push(message);
        buffer = buffer.slice(newline + 1);
        if (message.id === 1) child.stdin.end();
      }
    }
  })();
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "bohemia_prepare", arguments: { repoRoot: root }, _meta: { progressToken: "fixture-progress" } },
  }) + "\n");
  await reading;
  expect(await child.exited).toBe(0);
  expect(await stderr).toBe("");
  const heartbeats = messages.filter(message => message.method === "notifications/progress");
  expect(heartbeats.length).toBeGreaterThanOrEqual(2);
  const progress = heartbeats.find(message => message.params?.message?.includes("dependency install"));
  expect(progress?.params?.progressToken).toBe("fixture-progress");
  expect(progress?.params?.message).toContain("dependency install");
  expect(progress?.params?.message).toContain("reused=3, downloaded=0, added=2");
  expect(messages.at(-1)?.id).toBe(1);
  fs.rmSync(root, { recursive: true, force: true });
}, 45000);
