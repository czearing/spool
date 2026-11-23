type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

export function migratePendingMessages(prefix: string, storage: Storage) {
  const legacyKey = prefix.replace(/^spool-outbox:/, "spool-pending:").slice(0, -1);
  const source = storage.getItem(legacyKey);
  if (source === null) return;
  const messages: unknown = JSON.parse(source);
  if (!Array.isArray(messages)) throw new Error("Invalid saved messages.");
  for (const message of messages) {
    if (!message || typeof message.id !== "string" || typeof message.text !== "string" ||
        !Number.isFinite(Date.parse(message.created_at)) || !["sending", "queued", "failed"].includes(message.status))
      throw new Error("Invalid saved message.");
  }
  for (const message of messages) {
    const key = prefix + message.id, current = storage.getItem(key);
    if (current !== null) {
      const saved = JSON.parse(current);
      if (saved.id !== message.id || saved.text !== message.text) throw new Error("Saved message identity collision.");
    } else storage.setItem(key, JSON.stringify(message));
  }
  storage.removeItem(legacyKey);
}
