import { appFetch } from "../platform/request";
import { ConversationError, matchOperatorMessages, type OperatorMessage, type TaskConversation } from "./task-conversation";
import type { ChatSubmission } from "../components/ui/chat-input";

type Storage = Pick<globalThis.Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
// Keep one storage record when an explicitly rejected delivery receives a new ID.
type PendingMessage = OperatorMessage & { storageId?: string; rejected?: boolean };
export const isRetryableConversationError = (error: unknown) =>
  !(error instanceof ConversationError && error.status < 500 && ![408, 429].includes(error.status));
export const conversationRetryDelay = (attempt: number) => Math.min(500 * 2 ** Math.min(attempt, 4), 5000);
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
async function deliver(url: string, message: OperatorMessage) {
  const body = JSON.stringify({ id: message.id, message: message.text });
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fetchConversation(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (result.id !== message.id || !["accepted", "queued"].includes(result.state))
        throw new Error("Spool has not confirmed this message.");
      return;
    } catch (error) {
      if (!isRetryableConversationError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, conversationRetryDelay(attempt)));
    }
  }
}
export class ConversationOutbox {
  private messages: PendingMessage[] = [];
  private listeners = new Set<() => void>();
  private running?: Promise<void>;
  error = "";
  warning = "";
  constructor(readonly prefix: string, private storage: Storage) { this.refresh(); }
  snapshot = () => this.messages;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify() { for (const listener of this.listeners) listener(); }
  private key(message: PendingMessage) { return this.prefix + (message.storageId ?? message.id); }
  refresh() {
    try {
      const pending: PendingMessage[] = [];
      let unreadable = false;
      for (let index = 0; index < this.storage.length; index++) {
        const key = this.storage.key(index);
        if (!key?.startsWith(this.prefix)) continue;
        const json = this.storage.getItem(key);
        if (json === null) continue;
        try {
          const message = JSON.parse(json) as PendingMessage;
          if (!message || typeof message.id !== "string" || key !== this.key(message) ||
              typeof message.text !== "string" || !Number.isFinite(Date.parse(message.created_at)) ||
              !["sending", "queued", "failed"].includes(message.status)) throw new Error("Invalid pending message.");
          pending.push(message);
        } catch (error) {
          unreadable = true;
          console.error("Could not read a saved message; retaining its original record.", error);
        }
      }
      const ids = new Set(pending.map(message => message.id));
      this.messages = [...pending, ...this.messages.filter(message => !ids.has(message.id) && message.status === "queued")]
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      this.error = "";
      this.warning = unreadable ? "A saved message could not be read. Its record is preserved; other messages will still send." : "";
    } catch (error) {
      console.error("Could not restore pending messages.", error);
      this.error = "Pending messages could not be restored. Your draft has not been sent.";
      this.messages = [...this.messages];
    }
    this.notify();
  }
  enqueue(submission: ChatSubmission) {
    if (this.error) throw new Error(this.error);
    const previous = this.messages.find(message => message.id === submission.id);
    if (previous) {
      if (previous.text !== submission.markdown) throw new Error("Message identity was reused for different input.");
      return;
    }
    const message = { id: submission.id, text: submission.markdown, status: "sending",
      created_at: submission.createdAt ?? new Date().toISOString() };
    this.storage.setItem(this.prefix + message.id, JSON.stringify(message));
    this.messages = [...this.messages, message];
    this.notify();
  }
  private settle(message: PendingMessage) {
    try {
      this.storage.setItem(this.key(message), JSON.stringify(message));
    } catch (error) { console.error("Could not update the saved message receipt.", error); }
    this.messages = this.messages.map(saved => saved.id !== message.id ? saved : message);
    this.notify();
  }
  retry(id: string) {
    const previous = this.messages.find(message => message.id === id && message.status === "failed");
    if (!previous) return;
    const message = { ...previous, id: previous.rejected ? crypto.randomUUID() : previous.id,
      storageId: previous.storageId ?? previous.id, status: "sending", error: undefined, rejected: undefined };
    try { this.storage.setItem(this.key(message), JSON.stringify(message)); }
    catch {
      this.messages = this.messages.map(saved => saved.id === id
        ? { ...saved, error: "Could not save this retry. Your message is still here." } : saved);
      this.notify(); return;
    }
    this.messages = this.messages.map(saved => saved.id === id ? message : saved);
    this.notify();
  }
  flush(url: string, queued: () => void = () => {}) {
    return this.running ??= (async () => {
      for (;;) {
        const message = this.messages.find(message => message.status === "sending");
        if (!message) return;
        try {
          await deliver(url, message);
          this.settle({ ...message, status: "queued" });
          queued();
        } catch (error) {
          this.settle({ ...message, status: "failed", error: error instanceof Error ? error.message : String(error),
            rejected: error instanceof ConversationError && error.rejected });
        }
      }
    })().finally(() => { this.running = undefined; });
  }
  reconcile(data: TaskConversation) {
    if (!this.messages.length) return;
    const waiting = this.messages.filter(message => message.status === "queued");
    const logged = waiting.length ? matchOperatorMessages(data.entries, [...(data.task.interaction?.messages ?? []), ...waiting]) : new Map();
    const next = this.messages.filter(message => {
      if (message.status !== "queued" || !logged.has(message.id)) return true;
      try { this.storage.removeItem(this.key(message)); }
      catch (error) { console.error("Could not remove the confirmed message receipt.", error); }
      return false;
    });
    if (next.length !== this.messages.length) { this.messages = next; this.notify(); }
  }
}
const outboxes = new Map<string, ConversationOutbox>();
let watching = false;
export function pendingConversationMessages(project: string, task: string) {
  return outboxes.get(`spool-outbox:${encodeURIComponent(project)}:${encodeURIComponent(task)}:`)?.snapshot() ?? [];
}
export function conversationOutbox(project: string, task: string) {
  const prefix = `spool-outbox:${encodeURIComponent(project)}:${encodeURIComponent(task)}:`;
  let outbox = outboxes.get(prefix);
  if (!outbox) {
    const storage: Storage = {
      get length() { return localStorage.length; }, key: index => localStorage.key(index),
      getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: key => localStorage.removeItem(key),
    };
    outbox = new ConversationOutbox(prefix, storage);
    try {
      const key = `spool-chat:${project}:${task}`, draft = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (!task.startsWith("new:") && draft?.pending?.id && typeof draft.pending.markdown === "string") {
        outbox.enqueue(draft.pending);
        sessionStorage.setItem(key, JSON.stringify({ markdown: draft.markdown === draft.pending.markdown ? "" : draft.markdown }));
      }
    } catch (error) {
      console.error("Could not recover the previous pending draft.", error);
      outbox.error = "The previous message could not be saved for delivery. Your draft is still here.";
    }
    outboxes.set(prefix, outbox);
  }
  if (!watching) {
    watching = true;
    window.addEventListener("storage", event => {
      for (const [prefix, outbox] of outboxes) if (event.key === null || event.key.startsWith(prefix)) outbox.refresh();
    });
  }
  return outbox;
}
export function resumeConversationOutboxes() {
  try {
    const conversations = new Map<string, [string, string]>();
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index), match = key?.match(/^spool-outbox:([^:]+):([^:]+):[^:]+$/);
      if (match) conversations.set(`${match[1]}:${match[2]}`, [decodeURIComponent(match[1]), decodeURIComponent(match[2])]);
    }
    for (const [project, task] of conversations.values()) void conversationOutbox(project, task)
      .flush(`/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}/conversation`);
  } catch (error) { console.error("Could not resume saved messages.", error); }
}
