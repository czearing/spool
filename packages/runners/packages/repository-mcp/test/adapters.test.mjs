import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bohemiaAdapter, configuredBohemiaTransport } from "../src/adapters/bohemia.mjs";
import { listTools, callTool, loadAdapters } from "../src/registry.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "repository-adapters-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
test("local registrations are refused before any source operations, even with native flags", () => {
  const file = path.join(scratch, "local-native.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, library: { prerequisiteMode: "native" } }));
  expect(() => loadAdapters({ REPOSITORY_MCP_CONFIG: file }))
    .toThrow("local Scalar/WSL profiles are no longer supported");
});
for (const brokenRole of ["review", "peer", "assigned"]) {
  test(`1JS callbacks validate only their selected workspace dependencies: ${brokenRole}`, async () => {
    const root = fs.mkdtempSync(path.join(scratch, "workspace-dependencies-"));
    const profiles = {};
    for (const role of ["review", "peer", "assigned"]) {
      const workspace = path.join(root, role);
      fs.mkdirSync(workspace);
      const file = path.join(root, `${role}.json`);
      fs.writeFileSync(file, JSON.stringify({
        version: 1, purpose: role === "review" ? "review" : "engineering",
        ...(role === "review" ? { repositoryReview: true } : {}),
        codespace: `space-${role}`, githubAccount: "fixture",
        connector: role === brokenRole ? path.join(root, "missing-connect.ts") : process.execPath,
        nodeExecutable: process.execPath, azureCliDirectory: root, workspace,
        remoteRoot: "/workspaces/1JS", remoteTools: `/workspaces/.tools-${role}`,
        minimumFreeGiB: 12,
        nativeProfile: { repoRoot: "/workspaces/1JS", toolchainRoot: "/workspaces/1JS",
          storageRoot: "/workspaces", baseBranch: "main", nodeExecutable: "/usr/bin/node" },
      }));
      profiles[role] = file;
    }
    const file = path.join(root, "registry.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, codespaceReview: profiles.review,
      codespaceWorkspaces: [profiles.peer, profiles.assigned] }));
    const adapters = loadAdapters({ REPOSITORY_MCP_CONFIG: file,
      REPOSITORY_CODESPACE_SESSION: JSON.stringify({ codespace: "space-assigned",
        root: "/workspaces/1JS", tools: "/workspaces/.tools-assigned" }) });
    const tools = await adapters.find(adapter => adapter.id === "1js").tools();
    expect(tools.map(tool => tool.operation)).toEqual(["prepare", "build", "check", "pr"]);
    await expect(callTool(adapters, { name: "repo_check", arguments: { repo: "1js", input: {} } }))
      .rejects.toThrow(brokenRole === "assigned" ? "Codespace connector" : "preparation.json");
  });
}
describe("Bohemia is an opaque delegation boundary", () => {
  test("all four schemas, arguments and complete results are forwarded without mutation", async () => {
    const operations = ["prepare", "build", "check", "pr"];
    const originals = operations.map(operation => ({
      name: `bohemia_${operation}`, description: `${operation} original policy`,
      inputSchema: { type: "object", required: ["original"], properties: { original: { const: operation } } },
    }));
    const requests = [];
    const result = { content: [{ type: "text", text: "Original formatting and publication response" }], structuredContent: { original: true }, isError: false };
    const adapter = bohemiaAdapter({
      request: async (...args) => {
        requests.push(args);
        return args[1] === "tools/list" ? { tools: originals } : result;
      },
    });
    const tools = await adapter.tools();
    for (const [index, operation] of operations.entries()) {
      expect(tools[index].inputSchema).toBe(originals[index].inputSchema);
      expect(tools[index].description).toBe(originals[index].description);
      const input = Object.freeze({ original: operation, title: "Keep original title", solution: "| Before | After |\n![image](https://example.invalid/a.png)" });
      expect(await adapter.call(operation, input, { progressToken: "progress" })).toBe(result);
      expect(requests.at(-1)[2]).toEqual({
        name: `bohemia_${operation}`, arguments: input, _meta: { progressToken: "progress" },
      });
      expect(requests.at(-1)[2].arguments).toBe(input);
      expect(requests.at(-1)[0].args.at(-1)).toEndWith(path.join("bohemia-pr-mcp", "src", "index.ts"));
    }
  });
  test("original tool errors are not converted into success or an alternate publication route", async () => {
    const refusal = { isError: true, content: [{ type: "text", text: "Rejected by existing gate" }] };
    const adapter = bohemiaAdapter({ request: async () => refusal });
    expect(await callTool([adapter], { name: "repo_pr", arguments: { repo: "bohemia", input: { action: "create" } } })).toBe(refusal);
  });
  test("retains the original registered executable, arguments and environment including checkout search roots", async () => {
    const home = fs.mkdtempSync(path.join(scratch, "copilot-"));
    const registration = {
      command: path.join(home, "original-runtime.exe"),
      args: ["run", path.join(home, "original-bohemia.ts")],
      env: { BOHEMIA_PR_MCP_SEARCH_ROOTS: path.join(home, "assigned-checkouts"), ORIGINAL_POLICY: "unchanged" },
    };
    const file = path.join(home, "mcp-config.json");
    const contents = JSON.stringify({ mcpServers: { "bohemia-pr": registration } });
    fs.writeFileSync(file, contents);
    const transport = configuredBohemiaTransport({ COPILOT_HOME: home });
    const adapter = bohemiaAdapter({ transport, request: async actual => {
      expect(actual).toEqual(registration);
      return { isError: false, content: [] };
    } });
    await adapter.call("pr", { action: "create" });
    expect(fs.readFileSync(file, "utf8")).toBe(contents);
  });
});

test("generic schemas retain adapter schemas and require an explicit profile", async () => {
  const schema = { type: "object", required: ["repoRoot"], properties: { repoRoot: { type: "string" } } };
  const adapter = {
    id: "example",
    tools: async () => ["prepare", "build", "check", "pr"].map(operation => ({ operation, inputSchema: schema })),
    call: async () => ({ original: true }),
  };
  const tools = await listTools([adapter]);
  expect(tools[0].inputSchema.oneOf[0].properties.input).toBe(schema);
  await expect(callTool([adapter], { name: "repo_build", arguments: { input: {} } })).rejects.toThrow("not registered");
  await expect(callTool([adapter], { name: "repo_build", arguments: { repo: "example", input: {}, command: "anything" } })).rejects.toThrow("only repo");
});

test("assigned sessions advertise flat arguments and retain old wrapped calls without permitting rerouting", async () => {
  const calls = [], schema = { type: "object", properties: { packages: { type: "array" } } };
  const adapter = { id: "1js", assigned: true,
    tools: async () => ["prepare", "build", "check", "pr"].map(operation => ({ operation, inputSchema: schema })),
    call: async (...args) => { calls.push(args); return "passed"; } };
  const tools = await listTools([adapter]);
  expect(tools[0].inputSchema).toBe(schema);
  await callTool([adapter], { name: "repo_check", arguments: {} });
  await callTool([adapter], { name: "repo_pr", arguments: { title: "Keep selection" } });
  await callTool([adapter], { name: "repo_build", arguments: { repo: "1js", input: {} } });
  expect(calls.map(call => call.slice(0, 2))).toEqual([
    ["check", {}], ["pr", { title: "Keep selection" }], ["build", {}],
  ]);
  await expect(callTool([adapter], { name: "repo_build", arguments: { repo: "bohemia", input: {} } }))
    .rejects.toThrow("not registered");
});
