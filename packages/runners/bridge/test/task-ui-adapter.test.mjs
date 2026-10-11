import assert from "node:assert/strict";
import test from "node:test";
import { issuesApi } from "../../monitor/src/host/issues.js";

const draft = {
  title: "A real task", description: "Original instructions", status: "todo", priority: "medium",
  workMode: "standard", assigneeAgentId: "software-engineer",
};

test("original dialog adapter rejects unsupported policies before writing", async () => {
  await assert.rejects(issuesApi.create("spool", { ...draft, workMode: "planning" }), /Incoming/);
  await assert.rejects(issuesApi.create("spool", { ...draft, assigneeAgentId: null }), /Select an available agent/);
  await assert.rejects(issuesApi.create("spool", { ...draft, projectWorkspaceId: "unsupported" }), /does not support/);
});

test("original dialog retries preserve durable identity across reloads and distinguish terminal failure", async t => {
  const storage = new Map(), requests = [];
  const originalFetch = globalThis.fetch;
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  } });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else delete globalThis.localStorage;
  });
  let mode = "network-failure";
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("control-options")) return Response.json({ taskEnabled: true, token: "fixture" });
    if (url.endsWith("/control")) {
      requests.push(JSON.parse(init.body));
      assert.equal(init.headers["x-spool-token"], "fixture");
      if (mode === "network-failure") throw new Error("Connection lost");
      return Response.json({ id: requests.at(-1).id });
    }
    assert.ok(url.includes("control-result?id="));
    return Response.json({ result: mode === "terminal-failure"
      ? { status: "failed", error: "Preparation failed" }
      : { status: "accepted", taskId: `manual-${requests.at(-1).id}` } });
  };
  await assert.rejects(issuesApi.create("spool", draft), /Connection lost.*preserves its identity/);
  mode = "terminal-failure";
  await assert.rejects(issuesApi.create("spool", draft), /Preparation failed.*starts a new request/);
  assert.equal(requests[0].id, requests[1].id);
  mode = "accepted";
  const result = await issuesApi.create("spool", draft);
  assert.notEqual(requests[1].id, requests[2].id);
  assert.equal(result.id, `manual-${requests[2].id}`);
  assert.equal(requests[2].prompt, draft.description);
  assert.equal(requests[2].workspace, "isolated");
  assert.equal(storage.size, 0);
});
