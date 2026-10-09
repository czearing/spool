import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

export type Dispatch = (request: Request) => Promise<Response>;
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function requestUrl(request: IncomingMessage) {
  const host = request.headers.host ?? "", origin = `http://${host}`;
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) ||
    new URL(origin).port !== String(request.socket.localPort) ||
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") ||
    request.headers["sec-fetch-site"] === "cross-site" ||
    (request.headers.origin !== undefined && request.headers.origin !== origin) ||
    (!["GET", "HEAD"].includes(request.method ?? "") && request.headers.origin !== origin)) {
    throw new HttpError(403, "Local API requests must come from this development server.");
  }
  return new URL(request.url!, origin);
}
async function body(request: IncomingMessage) {
  if (["GET", "HEAD"].includes(request.method ?? "")) return undefined;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 1_000_000) throw new HttpError(413, "Request body exceeds the desktop limit.");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
export function apiMiddleware(dispatch: Dispatch) {
  const pending = new Set<AbortController>();
  async function serve(request: IncomingMessage, response: ServerResponse, controller: AbortController) {
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => {
      response.destroy();
      void reader?.cancel().catch(error => console.error("Cannot cancel development response:", error));
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      const url = requestUrl(request);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, item);
      }
      const result = await dispatch(new Request(url, {
        method: request.method, headers, body: await body(request), signal: controller.signal,
      }));
      response.statusCode = result.status;
      result.headers.forEach((value, key) => response.setHeader(key, key === "set-cookie" ? result.headers.getSetCookie() : value));
      response.flushHeaders();
      if (result.body) {
        reader = result.body.getReader();
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!response.write(value)) await once(response, "drain", { signal: controller.signal });
        }
      }
      response.end();
    } catch (error) {
      if (!controller.signal.aborted) {
        if (!(error instanceof HttpError)) console.error("Development API failed:", error);
        if (response.headersSent) response.destroy(error instanceof Error ? error : new Error(String(error)));
        else {
          response.writeHead(error instanceof HttpError ? error.status : 500, { "Content-Type": "application/json", Connection: "close" });
          response.end(JSON.stringify({ error: error instanceof HttpError ? error.message : "Local API failed. Check the development server log." }));
          request.resume();
        }
      }
    } finally {
      await reader?.cancel().catch(error => console.error("Cannot close development response:", error));
      controller.signal.removeEventListener("abort", cancel);
      request.off("aborted", abort); response.off("close", abort); pending.delete(controller);
    }
  }
  return {
    handle(request: IncomingMessage, response: ServerResponse, next: () => void) {
      if (!request.url?.startsWith("/api/")) { next(); return; }
      const controller = new AbortController();
      pending.add(controller);
      void serve(request, response, controller);
    },
    close() { for (const controller of pending) controller.abort(); },
  };
}
