import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

type Frame = { type: "head"; status: number; headers: [string, string][] }
  | { type: "chunk"; body: string } | { type: "end" } | { type: "error"; error: string };

export async function appFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!isTauri()) return fetch(input, init);
  const request = new Request(new URL(input instanceof Request ? input.url : input, "http://localhost"), init);
  const url = new URL(request.url), id = crypto.randomUUID();
  if (url.origin !== "http://localhost" || !url.pathname.startsWith("/api/")) throw new Error("Invalid desktop request.");
  if (request.signal.aborted) throw request.signal.reason;
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array>, finished = false, replied = false;
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      cancel() { cancel(); },
    });
    const cleanup = () => { finished = true; request.signal.removeEventListener("abort", abort); };
    const fail = (error: Error) => { if (finished) return; cleanup(); controller.error(error); if (!replied) reject(error); };
    const cancel = () => { void invoke("cancel_request", { id }).catch(console.error); cleanup(); };
    const abort = () => { fail(new DOMException("Request aborted", "AbortError")); cancel(); };
    const channel = new Channel<Frame>();
    channel.onmessage = frame => {
      if (finished) return;
      if (frame.type === "head") {
        replied = true;
        resolve(new Response([204, 205, 304].includes(frame.status) ? null : stream, { status: frame.status, headers: frame.headers }));
      } else if (frame.type === "chunk") {
        controller.enqueue(Uint8Array.from(atob(frame.body), character => character.charCodeAt(0)));
      } else if (frame.type === "end") { controller.close(); cleanup(); }
      else fail(new Error(frame.error));
    };
    request.signal.addEventListener("abort", abort, { once: true });
    void invoke("request", { request: { id, url: url.pathname + url.search, method: request.method,
      headers: [...request.headers], body }, channel }).catch(error => fail(new Error(String(error))));
  });
}
