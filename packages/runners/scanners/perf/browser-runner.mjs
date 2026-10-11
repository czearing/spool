import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { captureBrowserEvidence } from "./capture-browser.mjs";

export function captureProductionBrowser(options, capture) {
  if (capture) return captureWithServer(options, capture);
  // Bun's Windows extra-pipe support cannot drive Chromium's debugging transport.
  return new Promise((resolve, reject) => {
    execFile("node", [fileURLToPath(import.meta.url), "--request", JSON.stringify(options)], {
      windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`Production browser capture failed: ${stderr || error.message}`, { cause: error }));
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error("Invalid production browser worker result", { cause: error })); }
    });
  });
}

async function captureWithServer(options, capture = captureBrowserEvidence) {
  const { chromium } = await import("playwright");
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const server = spawn("node", ["dist/server-entry.js"], {
    cwd: path.join(options.repoRoot, "apps", "new-office"), windowsHide: true,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "production",
      NEW_OFFICE_DEPLOYMENT_PROFILE: "automation", NEW_OFFICE_DATA_SOURCE: "mock" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", startupError, browser;
  const append = data => { output = (output + data).slice(-12000); };
  server.stdout.on("data", append);
  server.stderr.on("data", append);
  server.on("error", error => { startupError = error; });
  const exited = new Promise(resolve => server.once("close", resolve));
  const baseURL = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 60000;
    for (;;) {
      if (startupError) throw startupError;
      assert.equal(server.exitCode, null, `Production server exited: ${output}`);
      assert.ok(Date.now() < deadline, `Production server did not become ready: ${output}`);
      let ready = false;
      try { ready = (await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch (error) {
        if (error.name !== "TimeoutError" && error.cause?.code !== "ECONNREFUSED" &&
            error.code !== "ConnectionRefused") throw error;
      }
      if (ready) break;
      await delay(100);
    }
    browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
    const report = await capture({ ...options, browser, baseURL });
    assert.equal(server.exitCode, null, `Production server failed during capture: ${output}`);
    return report;
  } finally {
    try { await browser?.close(); }
    finally {
      if (server.exitCode === null && server.pid) server.kill();
      await exited;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assert.ok(process.argv.length === 4 && process.argv[2] === "--request", "Use the production browser capture API");
    const options = JSON.parse(process.argv[3]);
    assert.ok(path.isAbsolute(options.repoRoot), "Production checkout must be absolute");
    console.log(JSON.stringify(await captureWithServer(options)));
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
