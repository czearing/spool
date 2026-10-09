import type { ConversationEntry } from "./task-conversation";

const credential = /^(?:provider|authorization|proxy-authorization|cookie|set-cookie|password|secret|token|(?:api|access|refresh|id|client)[_-]?(?:key|token|secret))$/i;
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, credential.test(key) ? "[redacted]" : scrub(item)]));
  return value;
}
function safeText(value: string | undefined, secrets: string[]) {
  if (value == null) return undefined;
  let text = value;
  try { text = JSON.stringify(scrub(JSON.parse(value)), null, 2); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  text = text.replace(/\bBearer\s+[a-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/((?:["']?)(?:password|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, '$1"[redacted]"');
  return text.length > 20000 ? `${text.slice(0, 20000)}\n[Long output shortened in this view.]` : text;
}
export function conversationToolOutput(entry: ConversationEntry, secrets: string[]): ConversationEntry {
  return { kind: entry.kind, ts: entry.ts, id: entry.id, offset: entry.offset, toolUseId: entry.toolUseId,
    ...(entry.kind !== "tool_result" ? { name: safeText(entry.name, secrets), input: safeText(entry.input, secrets) }
      : { content: safeText(entry.content, secrets), isError: entry.isError }) };
}
