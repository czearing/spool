import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { configureApplication } from "../src/lib/application-paths.ts";
import { copilotRuntimePath } from "../src/lib/copilot-runtime.ts";

test("packaged model runtime starts with the pinned SDK without a global CLI or sign-in", { timeout: 30000 }, async t => {
  configureApplication({ data: path.resolve(import.meta.dirname), resources: path.resolve(import.meta.dirname, "../src-tauri/resources") });
  const client = new CopilotClient({ connection: { kind: "stdio", path: copilotRuntimePath(),
    env: { ...process.env, PATH: "", COPILOT_CLI_PATH: "missing-global-copilot" } } });
  t.after(() => client.stop());
  await client.start();
  assert.equal((await client.ping("model-discovery-smoke")).message, "pong: model-discovery-smoke");
});
