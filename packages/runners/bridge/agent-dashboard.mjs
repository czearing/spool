import { monitorConversation, monitorSnapshot } from "./monitor-data.mjs";
import { createMonitorHandler } from "./monitor.mjs";

// Compatibility for direct users of the legacy diagnostic handler.
// Production uses the background snapshot worker in dashboard-rpc.mjs.
export function createAgentDashboard(store) {
  let snapshot, at = 0;
  const monitor = createMonitorHandler({
    snapshot() {
      if (!snapshot || Date.now() - at >= 1000) {
        snapshot = monitorSnapshot(store, store.processes());
        at = Date.now();
      }
      return snapshot;
    },
    conversation: (id, before) => monitorConversation(store, id, before),
  });
  return (request, response) => ["/", "/job", "/history"].includes(new URL(request.url, "http://127.0.0.1").pathname)
    ? false : monitor(request, response);
}
