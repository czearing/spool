import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { apiMiddleware } from "./http.ts";

async function fixture(t, dispatch) {
  const api = apiMiddleware(dispatch);
  const server = createServer((request, response) => api.handle(request, response, () => { response.writeHead(404); response.end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, api };
}
test("preserves request bodies, binary responses, headers and status", { timeout: 10000 }, async t => {
  const { origin } = await fixture(t, async request => {
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).search, "?value=1");
    assert.equal(await request.text(), '{"value":1}');
    return new Response(new Uint8Array([0, 255, 128]), { status: 201, headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  });
  const response = await fetch(`${origin}/api/example?value=1`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: '{"value":1}',
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 255, 128]));
});
test("rejects foreign origins, DNS rebinding hosts and originless writes before dispatch", { timeout: 10000 }, async t => {
  const { origin } = await fixture(t, async () => { assert.fail("Untrusted request reached the backend"); });
  for (const options of [
    { headers: { Origin: "https://example.com" } },
    { headers: { "Sec-Fetch-Site": "cross-site" } },
    { method: "POST" },
  ]) assert.equal((await fetch(`${origin}/api/example`, options)).status, 403);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/api/example`, { headers: { Host: "example.com" } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on("error", reject); request.end();
  });
  assert.equal(status, 403);
});
test("bounds request bodies and does not dispatch oversized input", { timeout: 10000 }, async t => {
  const { origin } = await fixture(t, async () => { assert.fail("Oversized body reached the backend"); });
  const response = await fetch(`${origin}/api/example`, { method: "POST", headers: { Origin: origin }, body: "x".repeat(1_000_001) });
  assert.equal(response.status, 413);
});
test("streams immediately and aborts the handler when the browser disconnects", { timeout: 10000 }, async t => {
  let observed;
  const stopped = new Promise(resolve => { observed = resolve; });
  const { origin } = await fixture(t, async request => {
    request.signal.addEventListener("abort", observed, { once: true });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: ready\n\n")); } }),
      { headers: { "Content-Type": "text/event-stream" } });
  });
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/events`, { signal: controller.signal });
  assert.equal(new TextDecoder().decode((await response.body.getReader().read()).value), "data: ready\n\n");
  controller.abort();
  await stopped;
});
test("server shutdown cancels open streams", { timeout: 10000 }, async t => {
  let signal;
  const { origin, api } = await fixture(t, async request => {
    signal = request.signal;
    return new Response(new ReadableStream());
  });
  await fetch(`${origin}/api/events`);
  api.close();
  assert.equal(signal.aborted, true);
});
