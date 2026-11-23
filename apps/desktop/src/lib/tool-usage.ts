import { dashboardWindow, isDashboardRange, type DashboardRange } from "./dashboard-range";

export type ToolCall = { name: string; action?: string; startedAt: number | null; endedAt?: number };
export type ToolUsageRow = { name: string; action: string; calls: number; timedCalls: number; totalMs: number | null };
export type ToolUsage = {
  range: DashboardRange; tools: ToolUsageRow[]; undated: number; invalidRecords: number; recordedSessions: number; missingSessions: number;
};

export function summarizeToolCalls(logs: Iterable<ToolCall>[], range: DashboardRange, now = new Date()): ToolUsage {
  const start = range === "all" ? -Infinity : dashboardWindow([], range, now).start;
  const rows = new Map<string, ToolUsageRow>();
  let undated = 0;
  for (const log of logs) for (const call of log) {
    if (call.startedAt === null) { undated++; if (range !== "all") continue; }
    else if (call.startedAt < start || call.startedAt > now.getTime()) continue;
    const action = call.action ?? "Description not recorded", key = JSON.stringify([call.name, action]);
    const row = rows.get(key) ?? { name: call.name, action, calls: 0, timedCalls: 0, totalMs: null };
    row.calls++;
    if (call.startedAt !== null && call.endedAt !== undefined && call.endedAt >= call.startedAt && call.endedAt <= now.getTime()) {
      row.timedCalls++;
      row.totalMs = (row.totalMs ?? 0) + call.endedAt - call.startedAt;
    }
    rows.set(key, row);
  }
  return { range, tools: [...rows.values()].sort((a, b) => b.calls - a.calls || a.action.localeCompare(b.action) || a.name.localeCompare(b.name)),
    undated, invalidRecords: 0, recordedSessions: logs.length, missingSessions: 0 };
}
export function isToolUsage(value: unknown): value is ToolUsage {
  if (!value || typeof value !== "object" || !("range" in value) || !isDashboardRange(value.range)
    || !("undated" in value) || typeof value.undated !== "number" || !Number.isSafeInteger(value.undated) || value.undated < 0
    || !("invalidRecords" in value) || typeof value.invalidRecords !== "number" || !Number.isSafeInteger(value.invalidRecords) || value.invalidRecords < 0
    || !["recordedSessions", "missingSessions"].every((key) => key in value && Number.isSafeInteger(Reflect.get(value, key)) && Reflect.get(value, key) >= 0)
    || !("tools" in value) || !Array.isArray(value.tools)) return false;
  const names = new Set<string>();
  return value.tools.every((row: unknown) => {
    if (!row || typeof row !== "object" || !("name" in row) || typeof row.name !== "string" || !row.name.trim()
      || !("action" in row) || typeof row.action !== "string" || !row.action.trim() || row.action.length > 1024
      || names.has(JSON.stringify([row.name, row.action]))
      || !("calls" in row) || typeof row.calls !== "number" || !Number.isSafeInteger(row.calls) || row.calls < 1
      || !("timedCalls" in row) || typeof row.timedCalls !== "number" || !Number.isSafeInteger(row.timedCalls) || row.timedCalls < 0 || row.timedCalls > row.calls
      || !("totalMs" in row) || (row.timedCalls === 0 ? row.totalMs !== null
        : typeof row.totalMs !== "number" || !Number.isFinite(row.totalMs) || row.totalMs < 0)) return false;
    names.add(JSON.stringify([row.name, row.action]));
    return true;
  });
}
export function formatToolTime(ms: number | null) {
  if (ms === null) return "Not recorded";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${Number((ms / 1000).toFixed(1))} s`;
  if (ms < 3600000) return `${Number((ms / 60000).toFixed(1))} min`;
  return `${Number((ms / 3600000).toFixed(1))} h`;
}
const toolLabels: Record<string, string> = {
  powershell: "PowerShell", view: "Read file", rg: "Search file contents", grep: "Search file contents (grep)", glob: "Find files",
  apply_patch: "Apply patch", edit: "Edit file", read_powershell: "Read command output", stop_powershell: "Stop command",
  web_fetch: "Fetch page", tool_search_tool: "Find tools",
};
export const toolLabel = (name: string) => toolLabels[name] ?? name;
