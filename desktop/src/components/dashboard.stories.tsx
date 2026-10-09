import type { Meta, StoryObj } from "@storybook/react-vite";
import { DashboardView } from "./dashboard";
import { summarizeTasks } from "../lib/dashboard";
import type { SpoolItem } from "../lib/spool-model";
import { useState } from "react";
import { defaultDashboardRange, type DashboardRange } from "../lib/dashboard-range";
import { ToolUsageView } from "./tool-usage";
import { summarizeToolCalls } from "../lib/tool-usage";

const now = new Date("2026-10-01T18:00:00Z");
const items: SpoolItem[] = Array.from({ length: 90 }, (_, index) => ({
  id: String(index), title: `Task ${index}`, status: index < 62 ? "completed" : index < 70 ? "in_progress" : index < 82 ? "incoming" : "failed",
  agent: ["engineer", "reviewer", "writer"][index % 3],
  updatedAt: new Date(now.getTime() - (index * index % 45) * 86_400_000).toISOString(),
}));
const usage = { available: true, unavailableSources: 0, records: items.map((item, index) => ({
  startedAt: item.updatedAt!, endedAt: item.updatedAt!, agent: item.agent!, costUsd: (index % 9 + 1) * 0.173,
})) };
function InteractiveDashboard({ empty = false, error }: { empty?: boolean; error?: string }) {
  const [range, setRange] = useState<DashboardRange>(defaultDashboardRange);
  const tools = summarizeToolCalls([empty ? [] : items.map((item, index) => ({
    name: ["powershell", "view", "apply_patch", "rg"][index % 4],
    action: ["Run targeted package tests", "Read src\\components\\dashboard.tsx", "Update the tool usage component", "Find existing chart helpers"][index % 4],
    startedAt: Date.parse(item.updatedAt!), endedAt: Date.parse(item.updatedAt!) + (index % 4 + 1) * 250,
  }))], range, now);
  return <DashboardView data={summarizeTasks(empty ? [] : items, now, range, ["engineer", "reviewer", "writer"], empty ? { ...usage, records: [] } : usage)}
    range={range} onRangeChange={setRange} error={error} tools={<ToolUsageView range={range} data={tools} />} />;
}
const meta = { title: "Home/Dashboard", component: DashboardView, parameters: { layout: "fullscreen" },
  args: { data: summarizeTasks(items, now, defaultDashboardRange, [], usage) },
} satisfies Meta<typeof DashboardView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { render: () => <InteractiveDashboard /> };
export const Empty: Story = { render: () => <InteractiveDashboard empty /> };
export const RefreshError: Story = { render: () => <InteractiveDashboard error="Task analytics are unavailable." /> };
