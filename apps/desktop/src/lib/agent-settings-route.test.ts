import { beforeEach, expect, it, vi } from "vitest";
import { agentSettingsRoute } from "./agent-settings-route";

const mocks = vi.hoisted(() => ({ supported: vi.fn(), tool: vi.fn(), catalog: vi.fn() }));
vi.mock("./projects", () => ({ getProjects: async () => [{ id: "new-project", root: "C:\\fixture" }] }));
vi.mock("./model-catalog", () => ({ getModelCatalog: mocks.catalog }));
vi.mock("./spool-agent-client", () => ({ callAgentTool: mocks.tool }));
vi.mock("./runtime-capabilities", () => ({ assertActiveRuntimeSupports: mocks.supported }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.tool.mockResolvedValue({ name: "researcher" });
  mocks.supported.mockResolvedValue(undefined);
});
const request = (method: string) => new Request("http://localhost/api/projects/new-project/agents", {
  method, headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
  body: JSON.stringify({ name: "researcher", prompt: "", model: null, image: null, max_concurrent_runs: 1 }),
});
it("creates a blank agent before the project's daemon has started", async () => {
  const response = await agentSettingsRoute(request("POST"), { params: Promise.resolve({ project: "new-project" }) });
  expect(response.status).toBe(201);
  expect(mocks.supported).not.toHaveBeenCalled();
  expect(mocks.catalog).not.toHaveBeenCalled();
  expect(mocks.tool).toHaveBeenCalledWith("C:\\fixture", "spool_create_agent",
    { name: "researcher", prompt: "", model: null, image: null, max_concurrent_runs: 1 });
});
it("checks active runtime compatibility for existing agent settings", async () => {
  await agentSettingsRoute(request("PUT"), { params: Promise.resolve({ project: "new-project", agent: "researcher" }) });
  expect(mocks.supported).toHaveBeenCalledWith("C:\\fixture", "agentSettingsVersion");
  expect(mocks.tool).toHaveBeenCalledWith("C:\\fixture", "spool_update_agent", expect.any(Object));
});
it("does not dispatch cross-origin agent creation", async () => {
  const input = request("POST");
  input.headers.set("origin", "https://foreign.invalid");
  expect((await agentSettingsRoute(input, { params: Promise.resolve({ project: "new-project" }) })).status).toBe(403);
  expect(mocks.tool).not.toHaveBeenCalled();
});
