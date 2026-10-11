import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { createDashboardServer } from "../dashboard/server.mjs";
import { renderDashboard } from "../dashboard/render.mjs";

test("dashboard renders the existing UI without embedding executable telemetry", () => {
  const html = renderDashboard({ gateRuns: [], mcpRuns: [{ title: "</script><script>bad()</script>" }] });
  assert.match(html, /Azure DevOps \| Bohemia Gate/);
  assert.doesNotMatch(html, /<script>bad/);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /STALE DATA:/);
});

test("dashboard uses live logs plus explicit private history, reports corrupt records and exposes only known routes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spool-dashboard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gateLog = path.join(root, "runs.jsonl"), mcpLog = path.join(root, "mcp.jsonl"), historyFile = path.join(root, "history.json");
  fs.writeFileSync(historyFile, JSON.stringify({ mcpRuns: [{ startedAt: "2026-01-01", toolName: "bohemia_pr", prId: 1 }] }));
  fs.writeFileSync(gateLog, [
    { runId: "fixture", kind: "run.start", at: "2026-01-01" },
    { runId: "fixture", kind: "run.end", at: "2026-01-01", exitCode: 0 },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  fs.writeFileSync(mcpLog, "");
  const server = createDashboardServer({ gateLog, mcpLog, historyFile });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const data = await (await fetch(`${base}/api/data`)).json();
  assert.equal(data.gateRuns[0].status, "succeeded");
  assert.equal(data.mcpRuns.length, 1);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.healthy, true);
  assert.match(health.sourceHash, /^[0-9a-f]{64}$/);
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/api/data`, { method: "POST" })).status, 405);
  fs.appendFileSync(gateLog, "{broken");
  assert.equal((await fetch(`${base}/api/health`)).status, 503);
  assert.equal((await (await fetch(`${base}/api/data`)).json()).diagnostics.length, 1);
  fs.writeFileSync(historyFile, "{broken");
  assert.equal((await fetch(`${base}/api/data`)).status, 500);
});
