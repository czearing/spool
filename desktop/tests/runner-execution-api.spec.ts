import { test, expect } from "./project-fixture";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

test("production APIs persist blocks, authenticate events and execute real HTTP with inspectable results", async ({ request, projectServer: server }) => {
  test.setTimeout(120000);
  const home = join(server.root, "runner-service"), config = join(home, "spool-runners.json");
  await mkdir(join(home, "bridge"), { recursive: true });
  const moduleUrl = (name: string) => pathToFileURL(resolve("..", "spool-runners", "bridge", name)).href;
  await writeFile(join(home, "bridge", "workflow-cli.mjs"), `import ${JSON.stringify(moduleUrl("workflow-cli.mjs"))};`);
  await writeFile(join(home, "bridge", "custom-run.mjs"), `export { runCustom } from ${JSON.stringify(moduleUrl("custom-run.mjs"))};`);
  await writeFile(config, JSON.stringify({ spool_dir: server.bohemia, node_binary: process.execPath }));
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ received: JSON.parse(body) })); });
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture has no port.");
  const supervisor = spawn(process.execPath, ["--input-type=module", "-e",
    `import { supervise } from ${JSON.stringify(moduleUrl("workflow-supervisor.mjs"))};
     const service=supervise(${JSON.stringify(config)});
     process.stdin.on("data", async () => { await service.stop(); process.stdin.pause(); });`],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let diagnostics = "";
  supervisor.stdout.on("data", chunk => { diagnostics += chunk; });
  supervisor.stderr.on("data", chunk => { diagnostics += chunk; });
  const token = "isolated-webhook-token-for-api-tests-only", oldToken = process.env.SPOOL_WORKFLOW_E2E_TOKEN;
  const endpoint = `${server.url}/api/projects/bohemia/runners/event-flow`;
  const headers = { Origin: server.url };
  try {
    process.env.SPOOL_WORKFLOW_E2E_TOKEN = token;
    await server.restart();
    const value = { id: "event-flow", name: "Event flow", kind: "custom", enabled: false, workspace: server.bohemia, intervalSeconds: 3600,
      nodes: [
        { id: "trigger", kind: "manual", label: "Manual", position: { x: 0, y: 0 } },
        { id: "filter", kind: "filter", label: "Only opened", field: "action", operator: "equals", compare: "opened", position: { x: 224, y: 0 } },
        { id: "data", kind: "data", label: "Map", body: '{"title":"{{input.title}}"}', position: { x: 448, y: 0 } },
        { id: "http", kind: "http", label: "Send", method: "POST", body: "{{input}}", url: `http://127.0.0.1:${address.port}`, position: { x: 672, y: 0 } },
      ], edges: [{ id: "one", source: "trigger", target: "filter" }, { id: "two", source: "filter", target: "data" }, { id: "three", source: "data", target: "http" }] };
    const created = await request.post(endpoint, { headers, data: value });
    expect(created.status(), await created.text()).toBe(201);
    let saved = await created.json();
    const executionId = randomUUID(), input = { action: "opened", title: "Typed result" };
    const run = { executionId, input, revision: saved.revision };
    expect((await request.post(`${endpoint}/runs`, { headers: { Origin: "https://untrusted.example" }, data: run })).status()).toBe(403);
    expect((await request.post(`${endpoint}/runs`, { headers, data: { ...run, revision: "stale" } })).status()).toBe(409);
    expect((await request.post(`${endpoint}/runs`, { headers, data: run })).status()).toBe(202);
    const detail = async (id: string) => (await request.get(`${endpoint}/runs?execution=${id}`)).json();
    await expect.poll(async () => (await detail(executionId)).status, { timeout: 20000, message: diagnostics }).toBe("succeeded");
    const completed = await detail(executionId);
    expect(completed.steps.at(-1).output).toEqual({ status: 200, body: { received: { title: input.title } } });
    expect(completed.steps.at(-1).input).toEqual({ title: input.title });
    expect((await request.post(`${endpoint}/runs`, { headers, data: run })).status()).toBe(202);
    expect((await (await request.get(`${endpoint}/runs`)).json())).toHaveLength(1);
    const changed = await request.put(endpoint, { headers, data: { ...saved, enabled: true,
      nodes: [{ ...saved.nodes[0], kind: "webhook", secretEnv: "SPOOL_WORKFLOW_E2E_TOKEN" }, ...saved.nodes.slice(1)] } });
    expect(changed.status()).toBe(200);
    saved = await changed.json();
    expect((await (await request.get(endpoint)).json()).nodes[0].secretEnv).toBe("SPOOL_WORKFLOW_E2E_TOKEN");
    const webhookId = randomUUID(), webhookHeaders = { Authorization: `Bearer ${token}`, "Idempotency-Key": webhookId };
    expect((await request.post(`${endpoint}/webhook`, { data: input })).status()).toBe(401);
    expect((await request.post(`${endpoint}/webhook`, { headers: webhookHeaders, data: input })).status()).toBe(202);
    await expect.poll(async () => (await detail(webhookId)).status, { timeout: 20000 }).toBe("succeeded");
    expect(JSON.stringify(await detail(webhookId))).not.toContain(token);
    expect((await request.post(`${endpoint}/webhook`, { headers: webhookHeaders, data: input })).status()).toBe(202);
    expect((await request.post(`${endpoint}/webhook`, { headers: webhookHeaders, data: { changed: true } })).status()).toBe(409);
    expect((await request.get(`${endpoint}/runs?execution=invalid`)).status()).toBe(400);
    expect((await request.post(`${endpoint}/webhook`, { headers: webhookHeaders, data: { text: "x".repeat(100001) } })).status()).toBe(413);
    const filteredId = randomUUID();
    expect((await request.post(`${endpoint}/runs`, { headers, data: { revision: saved.revision, executionId: filteredId, input: { action: "closed" } } })).status()).toBe(202);
    await expect.poll(async () => (await detail(filteredId)).status, { timeout: 20000 }).toBe("filtered");
    expect((await detail(filteredId)).steps).toHaveLength(1);
  } finally {
    if (oldToken === undefined) delete process.env.SPOOL_WORKFLOW_E2E_TOKEN;
    else process.env.SPOOL_WORKFLOW_E2E_TOKEN = oldToken;
    if (supervisor.exitCode === null) { const stopped = once(supervisor, "exit"); supervisor.stdin.end("stop\n"); await stopped; }
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  }
});
