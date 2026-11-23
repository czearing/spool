import { open } from "node:fs/promises";
import { hasCode } from "./file-snapshot";
import type { ToolCall } from "./tool-usage";
import { toolAction } from "./tool-action";

export type ToolLog = { calls: ToolCall[]; invalidRecords: number; available: boolean };
type Log = { identity: string; version: string; size: number; offset: number; anchor: Buffer; calls: Map<string, ToolCall>; invalidRecords: number };
const snapshot = (state: Log): ToolLog => ({ calls: [...state.calls.values()], invalidRecords: state.invalidRecords, available: true });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
function appendEvent(calls: Map<string, ToolCall>, line: string, offset: number) {
  if (!line.startsWith("{") || !/"tool\.execution_(start|complete)"/.test(line)) return true;
  let event: unknown;
  try { event = JSON.parse(line); }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  if (!record(event) || !["tool.execution_start", "tool.execution_complete"].includes(String(event.type))) return true;
  const data = record(event.data) ? event.data : event;
  const id = data.toolCallId ?? data.tool_call_id;
  const timestamp = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  if (event.type === "tool.execution_start") {
    const name = data.toolName ?? data.tool_name ?? data.name;
    if (typeof name !== "string" || !name.trim()) return false;
    const key = typeof id === "string" ? id : `line:${offset}`;
    if (!calls.has(key)) calls.set(key, { name, action: toolAction(name, data), startedAt: Number.isFinite(timestamp) ? timestamp : null });
  } else {
    const call = typeof id === "string" ? calls.get(id) : undefined;
    if (call && call.endedAt === undefined && Number.isFinite(timestamp)) call.endedAt = timestamp;
  }
  return true;
}

export function createToolLogReader() {
  const cache = new Map<string, Log>(), pending = new Map<string, Promise<ToolLog>>();
  async function read(file: string) {
    let handle;
    try { handle = await open(file, "r"); }
    catch (error) { if (hasCode(error, "ENOENT")) { cache.delete(file); return { calls: [], invalidRecords: 0, available: false }; } throw error; }
    try {
      const info = await handle.stat({ bigint: true }), size = Number(info.size);
      const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`, version = `${info.mtimeNs}:${info.ctimeNs}:${size}`;
      let saved = cache.get(file);
      if (saved?.identity === identity && saved.version === version) return snapshot(saved);
      if (saved && saved.identity === identity && size > saved.size) {
        const anchor = Buffer.alloc(saved.anchor.length);
        await handle.read(anchor, 0, anchor.length, saved.offset - anchor.length);
        if (!anchor.equals(saved.anchor)) saved = undefined;
      } else saved = undefined;
      const state: Log = saved ?? { identity, version, size, offset: 0, anchor: Buffer.alloc(0), calls: new Map(), invalidRecords: 0 };
      const previousInvalid = state.invalidRecords;
      let remainder = Buffer.alloc(0);
      if (size > state.offset) {
        for await (const chunk of handle.createReadStream({ start: state.offset, end: size - 1, autoClose: false, highWaterMark: 65536 })) {
          const buffer = Buffer.concat([remainder, chunk]);
          let start = 0, end: number;
          while ((end = buffer.indexOf(10, start)) !== -1) {
            if (!appendEvent(state.calls, buffer.subarray(start, end).toString("utf8").trim(), state.offset)) state.invalidRecords++;
            state.offset += end - start + 1;
            start = end + 1;
          }
          remainder = buffer.subarray(start);
          if (remainder.length > 16 * 1024 * 1024) throw new Error("A tool log line exceeds the 16 MiB read limit.");
          if (state.calls.size > 100000) throw new Error("A tool log exceeds the 100,000-call read limit.");
        }
      }
      state.anchor = Buffer.alloc(Math.min(state.offset, 64));
      await handle.read(state.anchor, 0, state.anchor.length, state.offset - state.anchor.length);
      state.size = size; state.version = version;
      cache.delete(file); cache.set(file, state);
      const oldest = cache.keys().next().value;
      if (cache.size > 2000 && oldest !== undefined) cache.delete(oldest);
      if (state.invalidRecords > previousInvalid) console.warn("Skipped malformed tool records.", { file, count: state.invalidRecords - previousInvalid });
      return snapshot(state);
    } catch (error) {
      cache.delete(file);
      throw new Error("Unable to read recorded tool calls.", { cause: error });
    } finally { await handle.close(); }
  }
  return (file: string): Promise<ToolLog> => {
    const existing = pending.get(file);
    if (existing) return existing;
    const result = read(file).finally(() => pending.delete(file));
    pending.set(file, result);
    return result;
  };
}
