import net from "node:net";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export async function acquireProcessLock(resource, { namespace = "agent-tooling", timeoutMs = 0 } = {}) {
  const key = createHash("sha256").update(resource).digest("hex");
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${namespace}-${key}` : `\0${namespace}-${key}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const server = net.createServer(socket => {
      socket.on("error", error => console.error(`Lock connection failed: ${error.message}`));
      socket.end();
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, resolve);
      });
      return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } catch (error) {
      if (error.code !== "EADDRINUSE" || timeoutMs === 0) throw error;
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`Timed out waiting for ${namespace} lock`), { code: "RESOURCE_LOCK_TIMEOUT" });
      }
      await sleep(Math.min(40 + Math.random() * 60, Math.max(1, deadline - Date.now())));
    }
  }
}
