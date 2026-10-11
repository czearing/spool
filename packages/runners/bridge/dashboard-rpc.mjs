import readline from "node:readline";
import path from "node:path";
import { runnerStates } from "./health.mjs";
import { SpoolStore } from "./spool-store.mjs";
import { createSpoolDashboard } from "./dashboard.mjs";
import { createMonitorClient, createMonitorHandler } from "./monitor.mjs";
import { readConfiguration } from "./config.mjs";
import { runnerNames, runnerSetting } from "./workflow-store.mjs";
import { runtimeRoot } from "./runtime-root.mjs";

const config = JSON.parse(process.env.SPOOL_RUNNER_CONFIG);
const names = process.argv.slice(2);
const root = path.join(runtimeRoot(), "runners");
let health = [];
const handler = createSpoolDashboard({
  store: new SpoolStore(config.spool_dir), root, names, health: () => health,
  baseUrl: `http://127.0.0.1:${config.dashboard_port}`,
});
const monitorClient = createMonitorClient(config.spool_dir);
const monitor = createMonitorHandler(monitorClient);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
await monitorClient.ready();
console.log(JSON.stringify({ ready: true }));
for await (const line of lines) {
  try {
    const request = JSON.parse(line);
    if (["/summary.json", "/jobs.json", "/api/status"].includes(new URL(request.url, "http://localhost").pathname)) {
      const latest = process.env.SPOOL_RUNNER_CONFIG_FILE ? readConfiguration(process.env.SPOOL_RUNNER_CONFIG_FILE) : config;
      health = await runnerStates(runnerNames(latest).filter(id => runnerSetting(latest, id).enabled), root);
    }
    const result = await new Promise((resolve, reject) => {
      let code = 200, headers = {};
      const response = {
        writeHead(status, values) { code = status; headers = values; },
        end(body = "") { resolve({ code, headers, body }); },
      };
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      const isMonitorRoute = pathname.startsWith("/api/monitor/") || pathname.startsWith("/assets/") || pathname.startsWith("/monitor") || pathname.startsWith("/spool");
      if (isMonitorRoute) {
        monitor(request, response).then(handled => {
          if (!handled) return handler(request, response);
        }).catch(reject);
      } else {
        handler(request, response).then(handled => {
          if (handled === false || code === 404) return monitor(request, response);
        }).catch(reject);
      }
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Dashboard request failed: ${error.stack || error}`);
    console.log(JSON.stringify({ code: 500, headers: { "content-type": "text/plain" }, body: error.message }));
  }
}
await monitorClient.close();
