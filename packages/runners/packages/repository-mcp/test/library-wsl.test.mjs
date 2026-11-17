import { expect, test } from "bun:test";
import path from "node:path";
import { libraryWslAdapter } from "../src/adapters/library-wsl.mjs";
import { libraryProfile, commandInvocation } from "../src/adapters/library-profile.mjs";

const root = path.resolve("perf-agent-test");
const config = {
  repoRoot: root, storageRoot: path.dirname(root), nodeExecutable: process.execPath,
  baseBranch: "main",
  wsl: {
    distribution: "1js-linux", repoRoot: "/home/dev/library",
    nodeExecutable: "/opt/node/bin/node", configFile: "/home/dev/config.json",
  },
};

test("native command profiles run pinned Yarn and metadata without a storage guard", () => {
  const profile = libraryProfile({
    repoRoot: process.cwd(), storageRoot: path.dirname(process.cwd()), nodeExecutable: process.execPath,
    yarnEntry: process.execPath, baseBranch: "main",
    metadataPackages: ["m365-copilot-app-library"],
  });
  expect(commandInvocation(profile, "build").args[0]).toBe(process.execPath);
  const metadata = commandInvocation(profile, "metadata");
  expect(metadata.args[0]).toBe(profile.metadataRunner);
  expect(JSON.parse(metadata.args.at(-1))).toEqual(["m365-copilot-app-library"]);
  expect(metadata.env.NPM_CONFIG_USERCONFIG).toBe(metadata.env.npm_config_userconfig);
});

test("WSL forwards exact native requests, progress, and validation results", async () => {
  const requests = [];
  const onProgress = () => {};
  const result = { content: [{ type: "text", text: "verified" }],
    structuredContent: { ready: true, steps: [{ command: "build", exitCode: 0 }] } };
  const adapter = libraryWslAdapter(config, {
    wake: async () => {},
    entrypoint: "C:\\server files\\index.mjs",
    realpath: value => value === root || value.startsWith("\\\\wsl.localhost\\") ? "native-checkout" : value,
    request: async (...args) => { requests.push(args); return result; },
  });
  const actual = await adapter.call("build", { repoRoot: root }, { progressToken: "p", onProgress });
  expect(requests[0][0]).toEqual({
    command: "wsl.exe",
    args: ["--distribution", "1js-linux", "--cd", "/home/dev/library", "--exec", "bash", "-lc",
      'export REPOSITORY_MCP_CONFIG="$1"; shift; exec "$@"', "repository-mcp",
      "/home/dev/config.json", "/opt/node/bin/node", "/mnt/c/server files/index.mjs"],
  });
  expect(requests[0][2]).toEqual({
    name: "repo_build", arguments: { repo: "1js", input: { repoRoot: "/home/dev/library" } },
    _meta: { progressToken: "p" },
  });
  expect(requests[0][3].onProgress).toBe(onProgress);
  expect(actual.structuredContent.steps).toBe(result.structuredContent.steps);
  expect(actual.structuredContent.repoRoot).toBe(root);
  expect(actual.structuredContent.execution.nativeRepoRoot).toBe("/home/dev/library");
});

test("WSL refuses unregistered checkouts, mismatched mounts, and unsupported input before execution", async () => {
  let requests = 0;
  const adapter = libraryWslAdapter(config, {
    wake: async () => {},
    entrypoint: "C:\\server\\index.mjs", realpath: value => value,
    request: async () => { requests++; },
  });
  await expect(adapter.call("build", { repoRoot: "C:\\elsewhere" })).rejects.toThrow("registered");
  await expect(adapter.call("build", { repoRoot: root })).rejects.toThrow("registered");
  await expect(adapter.call("build", { repoRoot: root, shell: "arbitrary" })).rejects.toThrow("Unsupported");
  expect(requests).toBe(0);
});

test("WSL preserves native errors rather than reporting readiness", async () => {
  const error = { isError: true, content: [{ type: "text", text: "real compiler failure" }] };
  const adapter = libraryWslAdapter(config, {
    wake: async () => {},
    entrypoint: "C:\\server\\index.mjs", realpath: () => "same-checkout",
    request: async () => error,
  });
  expect(await adapter.call("build", { repoRoot: root })).toBe(error);
});

test("startup is gated per checkout; status and stop remain usable at low disk capacity", async () => {
  let requests = 0, wakes = 0;
  const dependencies = {
    wake: async () => { wakes++; },
    entrypoint: "C:\\server\\index.mjs", realpath: () => "same-checkout",
    statfs: () => ({ bavail: 0, bsize: 4096 }),
    request: async (transport, method, params) => {
      requests++;
      expect(params.name).toBe("repo_start");
      expect(params.arguments.input.repoRoot).toBe(config.wsl.repoRoot);
      return { content: [], structuredContent: { ready: false, phase: "stopped" } };
    },
  };
  await expect(libraryWslAdapter(config, dependencies).call("start", { repoRoot: root })).rejects.toThrow("not enabled");
  expect(wakes).toBe(0);
  const adapter = libraryWslAdapter({ ...config, startEnabled: true }, dependencies);
  await expect(adapter.call("start", { repoRoot: root })).rejects.toThrow();
  await adapter.call("start", { repoRoot: root, action: "status" });
  await adapter.call("start", { repoRoot: root, action: "stop" });
  expect(requests).toBe(2);
});

test("WSL routes prepare, check, bundle, PR create and PR update through the same MCP transport", async () => {
  const requests = [];
  const adapter = libraryWslAdapter(config, {
    wake: async () => {},
    entrypoint: "C:\\server\\index.mjs", realpath: () => "same-checkout",
    request: async (...args) => { requests.push(args); return { content: [] }; },
  });

  const cases = [
    ["prepare", { operation: "setup" }],
    ["check", {}],
    ["build", { target: "bundle" }],
    ["pr", { action: "create", sourceBranch: "user/test/library", category: "fix",
      title: "Retain Library selection", problem: "Selection resets.",
      solution: "Selection is retained.", validation: "The checks passed.", uiChange: false,
      rollback: { kind: "not-possible", detail: "This corrects existing behavior." },
      accessibility: "No interaction changes.", documentation: "No changes required." }],
    ["pr", { action: "update", pullRequestId: 12, title: "Keep Library selection" }],
  ];
  for (const [operation, fields] of cases) {
    await adapter.call(operation, { repoRoot: root, ...fields });
    expect(requests.at(-1)[1]).toBe("tools/call");
    expect(requests.at(-1)[2]).toEqual({
      name: `repo_${operation}`,
      arguments: { repo: "1js", input: { repoRoot: config.wsl.repoRoot, ...fields } },
    });
  }
});

test("WSL starts the native distribution before resolving its UNC mount and propagates startup failures", async () => {
  let started = false;
  const adapter = libraryWslAdapter(config, {
    entrypoint: "C:\\server\\index.mjs",
    wake: async (command, args) => {
      expect(command).toBe("wsl.exe");
      expect(args).toEqual(["--distribution", "1js-linux", "--exec", "/usr/bin/true"]);
      started = true;
    },
    realpath: () => {
      if (!started) throw Object.assign(new Error("distribution is cold"), { code: "ETIMEDOUT" });
      return "same-checkout";
    },
    request: async () => ({ content: [] }),
  });

  await adapter.call("build", { repoRoot: root });
  const failed = libraryWslAdapter(config, {
    entrypoint: "C:\\server\\index.mjs",
    wake: async () => { throw new Error("WSL startup failed"); },
    realpath: () => { throw new Error("must not access the cold mount"); },
    request: async () => { throw new Error("must not execute MCP"); },
  });
  await expect(failed.call("build", { repoRoot: root })).rejects.toThrow("WSL startup failed");
});

test("WSL translates retained Windows performance evidence without changing other fields", async () => {
  let actual;
  const adapter = libraryWslAdapter(config, {
    wake: async () => {}, entrypoint: "C:\\server\\index.mjs", realpath: () => "same-checkout",
    request: async (_transport, _method, params) => { actual = params.arguments.input; return { content: [] }; },
  });
  await adapter.call("pr", { repoRoot: root, action: "update", pullRequestId: 12,
    performanceBoundary: "data-layer", performanceEvidence: "C:\\Agent Logs\\1JS-Perf\\evidence.json" });
  expect(actual.performanceEvidence).toBe("/mnt/c/Agent Logs/1JS-Perf/evidence.json");
  expect(actual.performanceBoundary).toBe("data-layer");
});

test("independent registered checkouts route to their own native config and preserve perf", async () => {
  const second = { ...config, repoRoot: path.resolve("software-engineer-test"),
    wsl: { ...config.wsl, repoRoot: "/home/dev/software-engineer", configFile: "/home/dev/engineer.json" } };
  const calls = [];
  const adapter = libraryWslAdapter({ ...config, checkouts: [second] }, {
    wake: async () => {}, entrypoint: "C:\\server\\index.mjs", realpath: () => "verified",
    request: async (...args) => { calls.push(args); return { structuredContent: { ready: true }, content: [] }; },
  });
  const engineer = await adapter.call("check", { repoRoot: second.repoRoot });
  expect(calls[0][0].args).toContain("/home/dev/engineer.json");
  expect(calls[0][2].arguments.input.repoRoot).toBe("/home/dev/software-engineer");
  expect(engineer.structuredContent.repoRoot).toBe(second.repoRoot);
  await adapter.call("build", { repoRoot: root });
  expect(calls[1][0].args).toContain(config.wsl.configFile);
  expect(calls[1][2].arguments.input.repoRoot).toBe(config.wsl.repoRoot);
  await expect(adapter.call("build", { repoRoot: path.resolve("other-agent") })).rejects.toThrow("registered");
});

test("a registered dangling mount can bootstrap only from its explicit seed through native MCP", async () => {
  const second = { ...config, repoRoot: path.resolve("software-engineer-test"), seedRoot: root,
    wsl: { ...config.wsl, repoRoot: "/home/dev/software-engineer", seedRoot: config.wsl.repoRoot } };
  let actual;
  const adapter = libraryWslAdapter({ ...config, checkouts: [second] }, {
    wake: async () => {}, entrypoint: "C:\\server\\index.mjs",
    realpath: () => { throw Object.assign(new Error("new checkout"), { code: "ENOENT" }); },
    readlink: () => "\\\\wsl.localhost\\1js-linux\\home\\dev\\software-engineer",
    request: async (...args) => { actual = args; return { structuredContent: { ready: true }, content: [] }; },
  });
  await adapter.call("prepare", { repoRoot: second.repoRoot, seedRoot: root,
    operation: "branch", branch: "user/test/new", mode: "create" });
  expect(actual[0].args[3]).toBe("/home/dev");
  expect(actual[2].arguments.input.seedRoot).toBe(config.wsl.repoRoot);
  const redirected = libraryWslAdapter({ ...config, checkouts: [second] }, {
    wake: async () => {}, entrypoint: "C:\\server\\index.mjs",
    realpath: () => { throw Object.assign(new Error("new checkout"), { code: "ENOENT" }); },
    readlink: () => "\\\\wsl.localhost\\1js-linux\\home\\dev\\unexpected",
    request: async () => { throw new Error("must not execute"); },
  });
  await expect(redirected.call("prepare", { repoRoot: second.repoRoot, seedRoot: root,
    operation: "branch", branch: "user/test/new" })).rejects.toThrow("new checkout");
});

test("WSL guards real Windows storage capacity, not the VHDX virtual free-space figure", async () => {
  let inspected, invoked = false;
  const adapter = libraryWslAdapter(config, {
    statfs: file => { inspected = file; return { bavail: 3 * 1024 ** 3, bsize: 1 }; },
    wake: async () => { invoked = true; }, request: async () => { invoked = true; },
    realpath: () => "same-checkout", entrypoint: "C:\\server\\index.mjs",
  });
  await expect(adapter.call("build", { repoRoot: root })).rejects.toMatchObject({ code: "CREATOR_CAPACITY_LOW" });
  expect(inspected).toBe(config.storageRoot);
  expect(invoked).toBe(false);
});

test("package expansion is advertised for enabled child checkouts and never forwarded from a disabled root", async () => {
  const second = { ...config, addPackagesEnabled: true, repoRoot: path.resolve("software-engineer-test"),
    wsl: { ...config.wsl, repoRoot: "/home/dev/software-engineer", configFile: "/home/dev/engineer.json" } };
  const calls = [];
  const adapter = libraryWslAdapter({ ...config, checkouts: [second] }, {
    wake: async () => {}, realpath: () => "verified", entrypoint: "C:\\server\\index.mjs",
    request: async (...args) => { calls.push(args); return { content: [], structuredContent: { ready: true } }; },
  });
  expect((await adapter.tools()).some(tool => tool.operation === "add_packages")).toBe(true);
  const packages = ["@1js/promise-utils"];
  await expect(adapter.call("add_packages", { repoRoot: root, packages })).rejects.toThrow("not enabled");
  expect(calls).toHaveLength(0);
  await adapter.call("add_packages", { repoRoot: second.repoRoot, packages });
  expect(calls[0][2].name).toBe("repo_add_packages");
  expect(calls[0][2].arguments).toEqual({ repo: "1js", input: { repoRoot: second.wsl.repoRoot, packages } });
});
