import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { renderDashboard } from "./render.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function createDashboardServer({
  gateLog = path.join(process.env.USERPROFILE || process.env.HOME, ".bohemia-gate", "runs.jsonl"),
  mcpLog = path.join(process.env.USERPROFILE || process.env.HOME, ".bohemia-gate", "mcp-runs.jsonl"),
  historyFile = process.env.BOHEMIA_DASHBOARD_HISTORY,
} = {}) {
const GATE_LOG = gateLog, MCP_LOG = mcpLog, DATA_JSON = historyFile;
const sourceHash = createHash("sha256")
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .update(fs.readFileSync(path.join(__dirname, "render.mjs"))).digest("hex");

function readLines(file, diagnostics) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return text.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch { diagnostics.push(`${path.basename(file)}: unreadable record at line ${index + 1}`); return []; }
  });
}

function getFreshData() {
  const diagnostics = [];
  let staticMcp = [];
    if (DATA_JSON) {
      const parsed = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
      staticMcp = parsed.mcpRuns || [];
      if (!Array.isArray(staticMcp)) throw new Error("Dashboard history mcpRuns must be an array");
    }

  const liveMcp = readLines(MCP_LOG, diagnostics);

  // Combine static and live MCP runs, deduplicating by startedAt + toolName
  const allMcpMap = new Map();
  for (const item of [...staticMcp, ...liveMcp]) {
    const key = `${item.startedAt}-${item.toolName}-${item.prId || ""}`;
    allMcpMap.set(key, item);
  }
  const mcpRuns = Array.from(allMcpMap.values()).sort((a, b) => {
    return (b.startedAt || "").localeCompare(a.startedAt || "");
  });

  const gateLines = readLines(GATE_LOG, diagnostics);

  const gateMap = new Map();
  for (const line of gateLines) {
    if (!line.runId) continue;
    if (!gateMap.has(line.runId)) {
      gateMap.set(line.runId, {
        runId: line.runId,
        action: line.action || "check",
        repo: line.repo || "",
        pid: line.pid,
        startTime: null,
        endTime: null,
        durationSeconds: null,
        exitCode: null,
        steps: []
      });
    }
    const run = gateMap.get(line.runId);
    if (line.repo && !run.repo) run.repo = line.repo;
    if (line.action && !run.action) run.action = line.action;
    if (line.kind === "run.start") {
      run.startTime = line.at;
      run.pid = line.pid;
      if (line.action) run.action = line.action;
      if (line.repo) run.repo = line.repo;
    } else if (line.kind === "run.end") {
      run.endTime = line.at;
      run.exitCode = line.exitCode;
      run.durationSeconds = line.seconds;
      run.reason = line.reason;
      if (line.action) run.action = line.action;
      if (line.repo) run.repo = line.repo;
    } else if (line.kind === "step") {
      run.steps.push({
        step: line.step,
        command: line.command,
        seconds: line.seconds,
        failed: line.failed,
        timedOut: line.timedOut,
        limit: line.limit,
        reason: line.reason,
        at: line.at
      });
    }
  }

  const gateRuns = Array.from(gateMap.values()).map(r => {
    let status = "unknown";
    if (r.exitCode === 0) {
      status = "succeeded";
    } else if (r.exitCode !== null && r.exitCode !== 0) {
      status = "failed";
    } else if (r.steps.some(s => s.failed || s.timedOut)) {
      status = "failed";
    } else if (!r.endTime && r.startTime) {
      status = "incomplete";
    }

    if (!r.durationSeconds && r.steps.length > 0) {
      r.durationSeconds = r.steps.reduce((acc, s) => acc + (s.seconds || 0), 0);
    }
    return { ...r, status };
  }).sort((a,b) => {
    const ta = a.startTime || (a.steps[0] ? a.steps[0].at : "") || "";
    const tb = b.startTime || (b.steps[0] ? b.steps[0].at : "") || "";
    return tb.localeCompare(ta);
  });

  return {
    generatedAt: new Date().toISOString(),
    diagnostics,
    gateRuns,
    mcpRuns
  };
}

const server = http.createServer((req, res) => {
 try {
  const url = new URL(req.url || "/", "http://localhost");
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, { Allow: "GET, HEAD" }); return res.end();
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (url.pathname === "/api/health") {
    const data = getFreshData();
    res.writeHead(data.diagnostics.length ? 503 : 200, { "Content-Type": "application/json" });
    return res.end(req.method === "HEAD" ? "" : JSON.stringify({
      healthy: !data.diagnostics.length, sourceRoot: __dirname, sourceHash, diagnostics: data.diagnostics,
    }));
  }

  if (url.pathname === "/api/data") {
    const data = JSON.stringify(getFreshData());
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0"
    });
    return res.end(req.method === "HEAD" ? "" : data);
  }

  if (url.pathname === "/api/raw-gate") {
    const raw = fs.existsSync(GATE_LOG) ? fs.readFileSync(GATE_LOG, "utf8") : "";
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0"
    });
    return res.end(req.method === "HEAD" ? "" : raw);
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = renderDashboard(getFreshData());
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0"
      });
      return res.end(req.method === "HEAD" ? "" : html);
  }

  res.writeHead(404); res.end("Not found");
 } catch (error) {
  console.error(`Dashboard request failed: ${error.message}`);
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(req.method === "HEAD" ? "" : JSON.stringify({ error: error.message }));
 }
});
return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3840);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
  createDashboardServer().listen(port, "127.0.0.1", () => {
    console.log(`Bohemia MCP Dashboard running at http://127.0.0.1:${port}/ from ${__dirname}`);
  });
}
