import net from "node:net";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execute } from "../process.mjs";
import { fileURLToPath } from "node:url";

export const REVIEW_RESOURCES = Object.freeze([
  "499b84ac-1321-427f-aa17-267ca6975798", "https://storage.azure.com/",
]);

export async function nativeFeedEnvironment(environment, run = execute) {
  const { stdout } = await run(process.execPath, [
    fileURLToPath(new URL("./azure-helper.mjs", import.meta.url)),
    "get-access-token", REVIEW_RESOURCES[0],
  ], { env: environment });
  const token = stdout.trim();
  if (!token) throw new Error("Approved feed authentication returned no credential");
  return { ...environment, ARTIFACTS_ACCESSTOKEN: token };
}

export function reviewCredentialResource(scope) {
  // The stock Codespaces cache requests the account scope for this already-approved Storage service.
  if (scope === "https://locallagecache.blob.core.windows.net/.default")
    return "https://storage.azure.com/";
  return REVIEW_RESOURCES.find(value =>
    scope === value || scope === `${value}/.default` || scope === `${value.replace(/\/$/, "")}/.default`);
}

export async function startAzureBroker(config, dependencies = {}) {
  const run = dependencies.execute || execute;
  const capability = randomBytes(32).toString("hex");
  const cached = new Map();
  const pending = new Map();
  async function acquire(resource) {
    if (!REVIEW_RESOURCES.includes(resource)) throw new Error("Resource is not approved for review preparation");
    if (cached.get(resource)?.expires > Date.now() + 120000) return cached.get(resource);
    if (pending.has(resource)) return pending.get(resource);
    const request = (async () => {
      const command = process.platform === "win32" ? "cmd.exe" : "az";
      const args = [...(process.platform === "win32" ? ["/d", "/c", "az"] : []),
        "account", "get-access-token", "--resource", resource, "-o", "json"];
      const { stdout } = await run(command, args, { env: { ...process.env,
        PATH: [config.azureCliDirectory, process.env.PATH].join(path.delimiter) } });
      const value = JSON.parse(stdout);
      const expires = Number(value.expires_on) * 1000;
      if (typeof value.accessToken !== "string" || !value.accessToken || !Number.isFinite(expires) || expires <= Date.now())
        throw new Error("Host Azure login did not return a valid expiring credential");
      const token = { value: value.accessToken, expires };
      cached.set(resource, token);
      return token;
    })();
    pending.set(resource, request);
    try { return await request; } finally { pending.delete(resource); }
  }
  // Prove both approved services can authenticate before altering the remote checkout.
  for (const resource of REVIEW_RESOURCES) await acquire(resource);
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => { socket.destroy(); });
    socket.setTimeout(30000, () => socket.destroy());
    let input = "", handled = false;
    socket.on("data", async chunk => {
      input += chunk;
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes("\n") || handled) return;
      handled = true;
      try {
        const request = JSON.parse(input.trim());
        const supplied = Buffer.from(typeof request.capability === "string" ? request.capability : "");
        const expected = Buffer.from(capability);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
          throw new Error("Unauthorized review credential request");
        if (request.action === "browser-refresh") {
          if (!dependencies.refreshPreview || !Number.isSafeInteger(request.prId) || request.prId < 1 ||
              !/^[a-f0-9]{40}$/.test(request.sourceCommit || ""))
            throw new Error("Invalid browser refresh request");
          socket.setTimeout(300000);
          await dependencies.refreshPreview({ prId: request.prId, sourceCommit: request.sourceCommit });
          socket.end(JSON.stringify({ refreshed: true }) + "\n");
        } else {
          if (request.action !== undefined) throw new Error("Unsupported credential request");
          const result = await acquire(request.resource);
          socket.end(JSON.stringify({ accessToken: result.value, expires_on: Math.floor(result.expires / 1000) }) + "\n");
        }
      } catch {
        // Do not return Azure CLI output or credentials to a caller.
        socket.end(JSON.stringify({ error: "Credential request rejected or host login requires renewal" }) + "\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { port: server.address().port, capability,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    } };
}
