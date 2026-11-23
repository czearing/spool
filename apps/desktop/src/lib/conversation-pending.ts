import type { ChatSubmission } from "../components/ui/chat-input";
import { matchOperatorMessages, type OperatorMessage, type TaskConversation } from "./task-conversation";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export class PendingConversationMessages {
  private messages: OperatorMessage[] = [];
  private listeners = new Set<() => void>();
  private error = "";
  constructor(private key: string, private storage: Storage) {
    try {
      const saved: unknown = JSON.parse(storage.getItem(key) ?? "[]");
      if (!Array.isArray(saved) || !saved.every(message => message && typeof message.id === "string" &&
        typeof message.text === "string" && Number.isFinite(Date.parse(message.created_at)) &&
        ["sending", "queued", "failed"].includes(message.status))) throw new Error("Invalid saved messages.");
      this.messages = saved;
    } catch (error) {
      console.error("Could not restore saved messages.", error);
      this.error = "Saved messages could not be restored. Your draft has not been sent.";
    }
  }
  snapshot = () => this.messages;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private save(messages: OperatorMessage[]) {
    if (messages.length) this.storage.setItem(this.key, JSON.stringify(messages));
    else this.storage.removeItem(this.key);
    this.messages = messages;
    for (const listener of this.listeners) listener();
  }
  enqueue(submission: ChatSubmission) {
    if (this.error) throw new Error(this.error);
    const previous = this.messages.find(message => message.id === submission.id);
    if (previous && previous.text !== submission.markdown) throw new Error("Message identity was reused for different input.");
    this.save([...this.messages.filter(message => message.id !== submission.id), {
      id: submission.id, text: submission.markdown, status: "sending",
      created_at: previous?.created_at ?? new Date().toISOString(),
    }]);
  }
  settle(id: string, error?: string) {
    const next = this.messages.map(message => message.id === id
      ? { ...message, status: error ? "failed" : "queued", error } : message);
    try { this.save(next); }
    catch (cause) {
      console.error("Could not persist the message receipt.", cause);
      this.messages = next;
      for (const listener of this.listeners) listener();
    }
  }
  reconcile(data: TaskConversation) {
    const matches = matchOperatorMessages(data.entries, this.messages);
    if (!matches.size) return;
    try { this.save(this.messages.filter(message => !matches.has(message.id))); }
    catch (error) { console.error("Could not remove confirmed message receipts.", error); }
  }
}
const conversations = new Map<string, PendingConversationMessages>();
export function pendingConversationMessages(project: string, task: string) {
  const key = `spool-pending:${encodeURIComponent(project)}:${encodeURIComponent(task)}`;
  let pending = conversations.get(key);
  if (!pending) {
    pending = new PendingConversationMessages(key, localStorage);
    conversations.set(key, pending);
  }
  return pending;
}
