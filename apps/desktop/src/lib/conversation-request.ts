import { appFetch } from "../platform/request";
import { ConversationError } from "./task-conversation";

export type ConversationResponseCache = { url?: string; etag?: string; value?: unknown };
export async function fetchConversation(url: string, init: RequestInit = {}, cache?: ConversationResponseCache) {
  const deadline = AbortSignal.timeout(10000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const headers = new Headers(init.headers);
  const cached = cache?.url === url && (init.method ?? "GET").toUpperCase() === "GET" ? cache : undefined;
  if (cached?.etag && cached.value !== undefined) headers.set("If-None-Match", cached.etag);
  const response = await appFetch(url, { ...init, headers, signal });
  if (response.status === 304) {
    signal.throwIfAborted();
    if (!cached?.etag || cached.value === undefined) throw new ConversationError("Conversation unavailable.", 502);
    return cached.value;
  }
  const body = await response.json().catch(error => {
    if (!response.ok) throw new ConversationError("Conversation unavailable.", response.status);
    throw error;
  });
  if (!response.ok) throw new ConversationError(typeof body?.error === "string" ? body.error : "Conversation unavailable.",
    response.status, body?.rejected === true);
  signal.throwIfAborted();
  if (cache && (init.method ?? "GET").toUpperCase() === "GET") {
    cache.url = url; cache.etag = response.headers.get("etag") ?? undefined; cache.value = body;
  }
  return body;
}
