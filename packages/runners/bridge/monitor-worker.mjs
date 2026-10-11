import { parentPort, workerData } from "node:worker_threads";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SpoolStore } from "./spool-store.mjs";
import { monitorSnapshot, monitorConversation } from "./monitor-data.mjs";
import { createMonitorControls } from "./monitor-controls.mjs";

const store = new SpoolStore(workerData.root);
const execute = promisify(execFile);
let stopped = false, timer, processes = [];
async function refreshProcesses() {
  const command = "Get-CimInstance Win32_Process -Filter \"Name='copilot.exe' OR Name='node.exe' OR Name='cmd.exe'\" | Select-Object Name,CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
  const value = stdout.trim() ? JSON.parse(stdout) : [];
  processes = Array.isArray(value) ? value : [value];
}
store.processes = () => processes;
const controls = createMonitorControls(store, { refreshProcesses });
const jobTimer = setInterval(() => controls.jobs().catch(error =>
  parentPort.postMessage({ refreshError: `Work-item preparation failed: ${error.message}` })), 1000);
async function refresh() {
  try {
    await refreshProcesses();
    const snapshot = monitorSnapshot(store, processes);
    parentPort.postMessage({ snapshot });
  } catch (error) {
    parentPort.postMessage({ refreshError: `Monitoring refresh failed: ${error.message}` });
  } finally {
    if (!stopped) timer = setTimeout(refresh, 5000);
  }
}
parentPort.on("message", message => {
  if (message.close) { stopped = true; clearTimeout(timer); clearInterval(jobTimer); parentPort.close(); return; }
  try {
    const data = message.operation === "options" ? controls.options()
      : message.operation === "submit" ? controls.submit(message.input)
      : message.operation === "receipt" ? controls.receipt(message.command)
      : monitorConversation(store, message.task, message.before);
    parentPort.postMessage({ id: message.id, data });
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: error.message, code: Number.isInteger(error.code) ? error.code : error instanceof RangeError ? 400 : 500 });
  }
});
refresh();
