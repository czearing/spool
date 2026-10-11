import { readAdoMetrics } from "../../lib/ado-transport.mjs";
import {
  createFleetDashboardLoader, renderDashboard, renderSummary,
  renderHistoryPage, renderJobDetail, renderDocument, renderAdoMetrics,
} from "./dashboard.mjs";

/** Route before reading telemetry. No request path performs an ADO or harness call. */
export function createDashboardHandler(directory, { load = createFleetDashboardLoader(), metrics = readAdoMetrics } = {}) {
  return (request, response) => {
    const send = (code, type, body = "") => {
      response.writeHead(code, {
        "content-type": `${type}; charset=utf-8`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        ...(code === 405 ? { allow: "GET, HEAD" } : {}),
      });
      response.end(request.method === "HEAD" ? "" : body);
    };
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const route = url.pathname;
      if (!["/", "/jobs.json", "/summary.json", "/ado.json", "/history", "/job", "/health", "/favicon.ico"].includes(route)) {
        send(404, "text/plain", "Not found");
        return;
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        send(405, "text/plain", "Method not allowed");
        return;
      }
      if (route === "/health") {
        send(200, "application/json", '{"ok":true,"scope":"dashboard HTTP only; not runner health"}');
        return;
      }
      if (route === "/favicon.ico") {
        send(204, "image/x-icon");
        return;
      }
      const id = url.searchParams.get("id");
      const offset = Number(url.searchParams.get("offset") || 0);
      if ((route === "/job" && !id) ||
          (route === "/history" && (!Number.isSafeInteger(offset) || offset < 0))) {
        send(400, "text/plain", "Invalid id or history offset");
        return;
      }
      if (request.method === "HEAD" && route !== "/job") {
        send(200, route.endsWith(".json") ? "application/json" : "text/html");
        return;
      }
      if (route === "/ado.json") {
        return Promise.resolve().then(() => metrics()).then((value) => {
          const scopes = Array.isArray(value) ? value : [];
          send(200, "application/json", JSON.stringify({ scopes, available: scopes.length > 0, html: renderAdoMetrics(scopes) }));
        }).catch(() => {
          send(503, "application/json", JSON.stringify({ scopes: [], available: false, error: "Local ADO metrics unavailable" }));
        });
      }
      const fleet = load(directory);
      if (route === "/summary.json") {
        send(200, "application/json", JSON.stringify({ summary: fleet.summary, revision: fleet.revision, html: renderSummary(fleet) }));
      } else if (route === "/jobs.json") {
        const { status, jobs, actions, summary } = fleet;
        send(200, "application/json", JSON.stringify({ status, jobs, actions, summary }));
      } else if (route === "/history") {
        send(200, "text/html", renderHistoryPage(fleet, offset));
      } else if (route === "/job") {
        const job = fleet.jobs.find((job) => job.jobId === id);
        if (!job) {
          send(404, "text/plain", "Job not found");
          return;
        }
        const detail = renderJobDetail(job);
        send(200, "text/html", url.searchParams.get("fragment") === "1" ? detail : renderDocument(`<a href="/">Dashboard</a>${detail}`));
      } else {
        send(200, "text/html", renderDashboard({ ...fleet, lazy: true }));
      }
    } catch (error) {
      send(error instanceof TypeError ? 400 : 500, "text/plain", String(error.message || error));
    }
  };
}
