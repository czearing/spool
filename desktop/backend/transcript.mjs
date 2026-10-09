export const maxEntryText = 20000;
function text(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(item => item?.type === "image" ? "[Image output]" : text(item?.text ?? item)).join("\n");
  if (value.content != null) return text(value.content);
  return JSON.stringify(value, null, 2);
}
export function bounded(value) {
  const result = text(value);
  return result.length > maxEntryText ? result.slice(0, maxEntryText) + "\n[Long output shortened in this view.]" : result;
}
export function appendEvents(previous, events, fallbackTime) {
  const entries = [...previous];
  for (const event of events) {
    const data = event.data || event, ts = event.timestamp || fallbackTime;
    if (["user.message", "assistant.message", "assistant.message_delta"].includes(event.type)) {
      const content = text(data.content ?? data.deltaContent ?? data.assistant_content);
      if (!content) continue;
      const delta = event.type === "assistant.message_delta", last = entries.at(-1);
      if (delta && last?.kind === "assistant" && last.delta) {
        if (last.text.length <= maxEntryText) entries[entries.length - 1] = { ...last, text: bounded(last.text + content) };
      } else if (event.type === "assistant.message" && last?.kind === "assistant" && last.delta) {
        entries[entries.length - 1] = { ...last, text: bounded(content), delta: false };
      } else entries.push({ kind: event.type.startsWith("user") ? "user" : "assistant", ts, text: bounded(content), delta });
    } else if (event.type === "tool.execution_start") {
      entries.push({ kind: "tool_call", ts, name: data.toolName || data.tool_name || data.name || "tool",
        toolUseId: data.toolCallId || data.tool_call_id || event.id, input: bounded(data.arguments) });
    } else if (event.type === "tool.execution_complete") {
      entries.push({ kind: "tool_result", ts, toolUseId: data.toolCallId || data.tool_call_id || event.id || `result-${entries.length}`,
        content: bounded(data.error ?? data.result), isError: data.success === false });
    } else if (event.type === "tool.execution_progress") {
      const index = entries.findLastIndex(entry => entry.kind === "tool_call" && entry.toolUseId === data.toolCallId);
      if (index >= 0) entries[index] = { ...entries[index],
        ...(data.title ? { name: data.title } : {}), ...(data.arguments != null ? { input: bounded(data.arguments) } : {}) };
    } else if (event.type === "session.plan") {
      const steps = (data.entries || []).slice(0, 100).map(step => ({ content: bounded(step.content), status: bounded(step.status) }));
      const index = entries.findLastIndex(entry => entry.kind === "plan");
      if (index >= 0) entries[index] = { ...entries[index], steps };
      else entries.push({ kind: "plan", ts, steps });
    } else if (event.type === "session.error") {
      entries.push({ kind: "stderr", ts, text: bounded(data.message ?? data) });
    } else if (event.type === "session.turn_end" && entries.at(-1)?.delta) {
      entries[entries.length - 1] = { ...entries.at(-1), delta: false };
    }
  }
  return entries;
}
