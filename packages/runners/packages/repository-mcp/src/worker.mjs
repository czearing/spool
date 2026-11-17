import { text } from "node:stream/consumers";
import readline from "node:readline";
import { loadAdapters, listTools, callTool } from "./registry.mjs";
import { failureResult } from "./errors.mjs";

const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);

async function handle(request, getAdapters = loadAdapters, lifecycle = false, onLifecycleFailure) {
  try {
    const adapters = getAdapters();
    const result = request.method === "tools/list"
      ? { tools: await listTools(adapters) }
      : await callTool(adapters, request.params, {
        progressToken: request.params?._meta?.progressToken,
        codespaceLifecycle: lifecycle,
        onLifecycleFailure,
        onProgress: params => write({ jsonrpc: "2.0", method: "notifications/progress", params }),
      });
    write({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    if (request.method === "tools/call") {
      write({
        jsonrpc: "2.0", id: request.id,
        result: failureResult(error, request.params?.name?.replace(/^repo_/, "")),
      });
    } else {
      write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } });
    }
  }
}

if (process.argv.includes("--codespace-lifecycle")) {
  let adapters;
  const lines = readline.createInterface({ input: process.stdin });
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const fail = message => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    stop();
  };
  try {
    await Promise.race([stopped, (async () => {
      let handled = false;
      for await (const line of lines) {
        if (handled) throw new Error("A repository lifecycle owns exactly one reviewer preparation");
        handled = true;
        await handle(JSON.parse(line), () => adapters ||= loadAdapters(), true, fail);
      }
    })()]);
  } finally {
    lines.close();
    for (const adapter of adapters || []) await adapter.dispose?.();
    process.stdin.destroy();
  }
} else {
  await handle(JSON.parse(await text(process.stdin)));
}
