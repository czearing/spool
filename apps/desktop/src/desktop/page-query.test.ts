import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { appFetch } from "../platform/request";
import { desktopPageQuery } from "./page-query";

vi.mock("../platform/request", () => ({ appFetch: vi.fn() }));
const fetch = vi.mocked(appFetch), clients: QueryClient[] = [];
const saved = { projects: [], agents: [], version: "", page: { kind: "setup" } };
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); fetch.mockReset(); });
function client() {
  const value = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  clients.push(value); return value;
}
const query = () => ({ ...desktopPageQuery("/fixture/agents/perf"), retryDelay: 0 });

it.each([
  new DOMException("Deadline expired", "TimeoutError"),
  new TypeError("Failed to fetch"),
  new Error("Desktop connection interrupted."),
])("automatically recovers a transient page read: %s", async error => {
  fetch.mockRejectedValueOnce(error).mockResolvedValueOnce(Response.json(saved));
  expect(await client().fetchQuery(query())).toEqual(saved);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([429, 503])("recovers a temporary HTTP %i without requiring a manual retry", async status => {
  fetch.mockResolvedValueOnce(new Response("Temporarily unavailable", { status }))
    .mockResolvedValueOnce(Response.json(saved));
  expect(await client().fetchQuery(query())).toEqual(saved);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not retry navigation cancellation or permanent HTTP errors", async () => {
  const cache = client(), reason = new DOMException("Navigated away", "AbortError");
  fetch.mockRejectedValueOnce(reason);
  await expect(cache.fetchQuery(query())).rejects.toBe(reason);
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockReset().mockResolvedValue(Response.json({ error: "Project not found." }, { status: 404 }));
  await expect(cache.fetchQuery(query())).rejects.toThrow("Project not found.");
  expect(fetch).toHaveBeenCalledOnce();
});
it("bounds recovery and retains the last successful page when the backend stays unavailable", async () => {
  const cache = client(), options = query();
  cache.setQueryData(options.queryKey, saved);
  fetch.mockRejectedValue(new Error("Desktop connection interrupted."));
  await expect(cache.fetchQuery({ ...options, staleTime: 0 })).rejects.toThrow("Desktop connection interrupted.");
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(cache.getQueryData(options.queryKey)).toEqual(saved);
});
it("retries an actual read deadline but stops promptly when navigation cancels recovery", async () => {
  const cache = client(), deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  fetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    started();
  })).mockResolvedValueOnce(Response.json(saved));
  const result = cache.fetchQuery(query());
  await ready;
  deadline.abort(new DOMException("Deadline expired", "TimeoutError"));
  expect(await result).toEqual(saved);
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockReset().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  }));
  const pending = cache.fetchQuery({ ...query(), staleTime: 0 });
  await cache.cancelQueries({ queryKey: query().queryKey });
  expect(await pending).toEqual(saved);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
  expect(cache.getQueryData(query().queryKey)).toEqual(saved);
});
