import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { requestMcp } from "../src/mcp-client.mjs";
import { azureDevOps } from "../src/azure-devops.mjs";
import { prepareRepositorySession } from "../src/client.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const server = {
  command: process.execPath,
  args: [fileURLToPath(new URL("../src/index.mjs", import.meta.url))],
  env: { REPOSITORY_MCP_CONFIG: "" },
};
const bohemia = {
  command: process.execPath,
  args: [fileURLToPath(new URL("../../bohemia-pr-mcp/src/index.ts", import.meta.url))],
};

test("the shared MCP discovers the unchanged Bohemia schemas over the real transport", async () => {
  const [original, generic] = await Promise.all([
    requestMcp(bohemia, "tools/list"),
    requestMcp(server, "tools/list"),
  ]);
  expect(generic.tools.map(tool => tool.name)).toEqual(["repo_prepare", "repo_build", "repo_check", "repo_pr"]);
  for (const tool of generic.tools) {
    const legacy = original.tools.find(item => item.name === tool.name.replace(/^repo_/, "bohemia_"));
    expect(tool.inputSchema.oneOf[0].properties.input).toEqual(legacy.inputSchema);
  }
});

test("Bohemia PR formatting rejection is byte-for-byte identical through the new MCP", async () => {
  const input = {
    action: "create", repository: "office-bohemia", sourceBranch: "user/test/library",
    category: "fix", title: "This title is intentionally far too long",
    problem: "The selection resets.", solution: "The selection is retained.",
    validation: "The focused tests passed.", uiChange: false,
  };
  const [original, generic] = await Promise.all([
    requestMcp(bohemia, "tools/call", { name: "bohemia_pr", arguments: input }),
    requestMcp(server, "tools/call", { name: "repo_pr", arguments: { repo: "bohemia", input } }),
  ]);
  expect(original.isError).toBe(true);
  expect(generic).toEqual(original);
});

test("the client retains original progress notifications and complete structured output", async () => {
  const progress = [];
  const input = { source: "untouched", table: "| Before | After |" };
  const result = await requestMcp({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))],
  }, "tools/call", {
    name: "example", arguments: input, _meta: { progressToken: "original-token" },
  }, { onProgress: value => progress.push(value) });
  expect(result.structuredContent).toEqual(input);
  expect(progress).toEqual([{ progressToken: "original-token", progress: 1, message: "original progress" }]);
});

test("managed MCP responses keep their process alive until their owner closes the session", async () => {
  const session = await requestMcp({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))],
  }, "tools/call", { arguments: { owned: true }, _meta: { progressToken: "managed" } }, { keepAlive: true });
  expect(session.result.structuredContent).toEqual({ owned: true });
  let exited = false;
  session.closed.then(() => { exited = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(exited).toBe(false);
  await session.close();
  expect(await session.closed).toBe(0);
  await session.close();
});

test("failed reviewer preparation closes its real MCP worker and managed client cleanly", async () => {
  await expect(prepareRepositorySession("1js", { repoRoot: "unregistered", reviewPullRequestId: 1 },
    { env: { REPOSITORY_MCP_CONFIG: "" } })).rejects.toThrow("not registered");
});

for (const command of [process.execPath, "node"]) for (const [kind, arguments_] of [
  ["review", { repo: "1js", input: { reviewPullRequestId: 1 } }],
  ["assigned review", { reviewPullRequestId: 1 }],
]) test(`lost ${kind} ownership closes its actual MCP lifecycle (${command})`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "repository-lifecycle-"));
  const disposed = path.join(directory, "disposed");
  let session, ended = false;
  try {
    for (const name of ["index.mjs", "worker.mjs", "errors.mjs"])
      fs.copyFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), path.join(directory, name));
    fs.writeFileSync(path.join(directory, "registry.mjs"), `
      import fs from "node:fs";
      export const loadAdapters = () => [{dispose: async () => fs.writeFileSync(${JSON.stringify(disposed)}, "released")}];
      export const listTools = async () => [];
      export const callTool = async (_adapters, _params, context) => {
        setTimeout(() => context.onLifecycleFailure("Fixture remote connection lost"), 100);
        return {isError:false,structuredContent:{ready:true}};
      };
    `);
    session = await requestMcp({ command, args: [path.join(directory, "index.mjs")],
      env: { REPOSITORY_CODESPACE_SESSION: "{}" } },
      "tools/call", { name: "repo_prepare", arguments: arguments_ },
      { keepAlive: true });
    expect(session.result.structuredContent.ready).toBe(true);
    let timer;
    const code = await Promise.race([session.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Lost MCP lifecycle did not close")), 5000);
    })]).finally(() => clearTimeout(timer));
    ended = true;
    expect(code).toBe(1);
    expect(fs.readFileSync(disposed, "utf8")).toBe("released");
    await expect(session.close()).rejects.toThrow("Fixture remote connection lost");
  } finally {
    if (session && !ended) await session.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unregistered profiles and unsupported fields fail through the actual MCP without shell execution", async () => {
  const result = await requestMcp(server, "tools/call", { name: "repo_build", arguments: { repo: "1js", input: { repoRoot: "anything" } } });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("not registered");
});

test("the real assigned gateway advertises flat tools and explains invalid publication without connecting", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assigned-mcp-"));
  try {
    const configFile = path.join(root, "codespace.json"), registry = path.join(root, "registry.json");
    fs.writeFileSync(configFile, JSON.stringify({
      version: 1, purpose: "engineering", codespace: "assigned-space", githubAccount: "fixture",
      connector: process.execPath, nodeExecutable: process.execPath, azureCliDirectory: root, workspace: root,
      remoteRoot: "/workspaces/1JS", remoteTools: "/workspaces/.assigned-tools", minimumFreeGiB: 12,
      nativeProfile: { repoRoot: "/workspaces/1JS", toolchainRoot: "/workspaces/1JS",
        storageRoot: "/workspaces", baseBranch: "main", nodeExecutable: "/usr/bin/node" },
    }));
    fs.writeFileSync(registry, JSON.stringify({ version: 1, codespaceWorkspaces: [configFile] }));
    const assigned = { ...server, env: { REPOSITORY_MCP_CONFIG: registry,
      REPOSITORY_CODESPACE_SESSION: JSON.stringify({ codespace: "assigned-space",
        root: "/workspaces/1JS", tools: "/workspaces/.assigned-tools" }) } };
    const catalog = await requestMcp(assigned, "tools/list");
    expect(catalog.tools).toHaveLength(4);
    for (const tool of catalog.tools) {
      expect(tool.inputSchema.properties.repo).toBeUndefined();
      expect(tool.inputSchema.properties.input).toBeUndefined();
      expect(tool.inputSchema.required).not.toContain("repoRoot");
    }
    const result = await requestMcp(assigned, "tools/call", { name: "repo_pr", arguments: {
      category: "fix", title: "Keep selection", problem: "Selection resets.", solution: "Preserve selection",
      validation: "Checks passed.", uiChange: false,
    } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("solution must end with a full stop");
    expect(result.structuredContent.operationError.code).toBe("invalid_input");
    expect(result.structuredContent.operationError.nextAction).toContain("Correct the listed fields");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Azure DevOps hosting is explicitly parameterized, not inherited from Bohemia's project", async () => {
  const requests = [];
  const host = azureDevOps({
    organization: "https://dev.azure.com/office", project: "Office", repository: "1JS",
  }, {
    accessToken: async () => "fixture-token",
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ value: [{ name: "refs/heads/main", objectId: "a".repeat(40) }] }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  expect(await host.tip("main")).toBe("a".repeat(40));
  expect(requests[0].url).toStartWith("https://dev.azure.com/office/Office/_apis/git/repositories/1JS/");
  expect(requests[0].init.redirect).toBe("manual");
  expect(host.url(1)).toBe("https://dev.azure.com/office/Office/_git/1JS/pullrequest/1");
});

test("authentication redirects cannot become success-shaped host responses", async () => {
  const host = azureDevOps({
    organization: "https://example.invalid", project: "Office", repository: "1JS",
  }, {
    accessToken: async () => "fixture-token",
    fetcher: async () => new Response("<html>sign in</html>", { status: 203, headers: { "Content-Type": "text/html" } }),
  });
  await expect(host.get(1)).rejects.toThrow("HTTP 203");
});
