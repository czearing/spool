import { afterEach, expect, it, vi } from "vitest";
import { POST } from "../app/api/file-picker/route";
import { pickNativePath, PickerError } from "./native-file-picker";

vi.mock("./native-file-picker", async (original) => ({
  ...await original<typeof import("./native-file-picker")>(), pickNativePath: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const request = (origin = "http://127.0.0.1:3000", kind = "folder", host = "127.0.0.1:3000", signal?: AbortSignal) =>
  new Request(`http://localhost:3000/api/file-picker?kind=${kind}`, { method: "POST", headers: { origin, host }, signal });

it.each(["http://evil.example", "null", "", "http://localhost:3000", "http://127.0.0.1:6006"])(
  "rejects foreign origin %s before opening anything", async (origin) => {
    expect((await POST(request(origin))).status).toBe(403);
    expect(pickNativePath).not.toHaveBeenCalled();
  });
it.each(["example.com:3000", "127.0.0.1.evil.example:3000", "192.168.1.2:3000"])(
  "rejects non-loopback host %s even with matching origin", async (host) => {
    expect((await POST(request(`http://${host}`, "folder", host))).status).toBe(403);
    expect(pickNativePath).not.toHaveBeenCalled();
  });
it.each(["localhost:6006", "127.0.0.1:3000", "[::1]:3000"])("supports same-origin loopback %s", async (host) => {
  vi.mocked(pickNativePath).mockResolvedValue("C:\\Projects");
  const result = await POST(request(`http://${host}`, "folder", host));
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual({ path: "C:\\Projects" });
  expect(pickNativePath).toHaveBeenCalledWith("folder", expect.any(AbortSignal));
});
it.each(["", "directory", "folder;Write-Output injected"])("rejects unsupported kind %s", async (kind) => {
  expect((await POST(request(undefined, kind))).status).toBe(400);
  expect(pickNativePath).not.toHaveBeenCalled();
});
it("treats cancellation as an empty selection, not an error", async () => {
  vi.mocked(pickNativePath).mockResolvedValue(null);
  expect(await (await POST(request(undefined, "file"))).json()).toEqual({ path: null });
});
it("reports an existing native dialog without opening another", async () => {
  vi.mocked(pickNativePath).mockRejectedValue(new PickerError("Already open", 409));
  expect((await POST(request())).status).toBe(409);
});
it("logs native failures and returns a recoverable error without process output", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(pickNativePath).mockRejectedValue(new Error("PRIVATE PROCESS OUTPUT"));
  const result = await POST(request());
  expect(result.status).toBe(500);
  expect(await result.text()).not.toContain("PRIVATE PROCESS OUTPUT");
  expect(log).toHaveBeenCalled(); log.mockRestore();
});
it("does not convert an aborted request into a picker success", async () => {
  const controller = new AbortController(); controller.abort();
  vi.mocked(pickNativePath).mockRejectedValue(controller.signal.reason);
  expect((await POST(request(undefined, undefined, undefined, controller.signal))).status).toBe(499);
});
