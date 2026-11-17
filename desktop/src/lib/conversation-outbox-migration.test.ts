import { expect, it } from "vitest";
import { migratePendingMessages } from "./conversation-outbox-migration";

const prefix = "spool-outbox:project:task:", legacy = "spool-pending:project:task";
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}
const message = (id: string, status = "queued") => ({ id, status, text: id, created_at: "2026-11-17T00:00:00Z" });

it("preserves old delivery identities and queued/failed state instead of resending them on upgrade", () => {
  const saved = storage(), messages = [message("queued"), message("failed", "failed"), message("sending", "sending")];
  saved.setItem(legacy, JSON.stringify(messages));
  migratePendingMessages(prefix, saved);
  expect(saved.getItem(legacy)).toBeNull();
  for (const value of messages) expect(JSON.parse(saved.getItem(prefix + value.id)!)).toEqual(value);
});
it("keeps the original array after a partial storage failure and safely resumes without overwriting newer receipts", () => {
  const saved = storage(), source = JSON.stringify([message("one"), message("two", "sending")]);
  saved.setItem(legacy, source);
  expect(() => migratePendingMessages(prefix, { ...saved, setItem(key, value) {
    if (key.endsWith("two")) throw new Error("Storage full");
    saved.setItem(key, value);
  } })).toThrow("Storage full");
  expect(saved.getItem(legacy)).toBe(source);
  saved.setItem(prefix + "one", JSON.stringify(message("one", "failed")));
  migratePendingMessages(prefix, saved);
  expect(JSON.parse(saved.getItem(prefix + "one")!).status).toBe("failed");
  expect(saved.getItem(legacy)).toBeNull();
});
it("leaves corrupt legacy data untouched rather than silently dropping saved messages", () => {
  const saved = storage();
  saved.setItem(legacy, JSON.stringify([message("valid"), { id: "invalid" }]));
  expect(() => migratePendingMessages(prefix, saved)).toThrow("Invalid saved message.");
  expect(saved.values.size).toBe(1);
});
