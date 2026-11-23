import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET } from "../app/api/models/route";

const mocks = vi.hoisted(() => ({ catalog: vi.fn() }));
vi.mock("./model-catalog", () => ({ getModelCatalog: mocks.catalog }));
beforeEach(() => { mocks.catalog.mockReset(); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });
it.each([
  ["SDK protocol version mismatch: SDK supports versions 3-3, but server reports version 4.", "runtime is incompatible"],
  ["Not authenticated", "sign-in is required"],
  ["Copilot CLI not found at C:\\private\\runtime.exe", "runtime is missing"],
  ["Copilot model discovery timed out.", "timed out"],
  ["Connection reset", "Other settings are still available"],
])("reports the actual failure category without blaming every error on sign-in: %s", async (detail, message) => {
  mocks.catalog.mockRejectedValue(new Error(detail));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const result = await response.json();
  expect(result.error).toContain(message);
  expect(result.error).not.toContain("C:\\private");
  if (!/authenticated/.test(detail)) expect(result.error).not.toContain("sign-in");
});
