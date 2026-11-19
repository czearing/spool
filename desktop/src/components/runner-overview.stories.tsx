import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { RunnerOverview } from "./runner-overview";
import type { Runner } from "../lib/runners";

const status: Runner = { id: "livesite", enabled: true, connected: true, running: true, healthy: true,
  stopping: false, phase: "ready", lastRunAt: "2026-10-21T19:30:00Z", lastSuccessAt: "2026-10-21T19:30:00Z", lastRunFailed: false,
  script: "runners\\livesite\\run.mjs", intervalSeconds: 300, activeIntervalSeconds: 300, error: null,
  repository: { mode: "on-demand", state: "unknown", lastUpdatedAt: null, lastAttemptAt: null, error: null } };
const meta = {
  title: "Runners", component: RunnerOverview, parameters: { layout: "fullscreen" },
  args: { name: "livesite", status, selected: null, onSelect: () => {}, href: id => `#${id || "live"}`,
    logs: { output: '2026-10-21T19:25:00Z [runner_started] pollSeconds=300 dryRun=false\n2026-10-21T19:30:00Z [scan_completed] builds=10 actionable=0 assigned=0',
      truncated: false, runs: [
        { id: "12345678-1234-1234-1234-123456789abc", status: "succeeded", source: "integration", createdAt: "2026-10-21T19:20:00Z" },
        { id: "87654321-1234-1234-1234-123456789abc", status: "failed", source: "integration", createdAt: "2026-10-21T18:45:00Z" },
      ] } },
  render: function Preview(args) {
    const [selected, onSelect] = useState<string | null>(args.selected);
    const run = args.logs?.runs.find(run => run.id === selected);
    const logs = args.logs && { ...args.logs, output: run
      ? run.status === "failed" ? "2026-10-21T18:45:00Z [Prepare checkout] failed\nWorkspace is occupied."
        : "2026-10-21T19:20:00Z [Dispatch agent] succeeded\n{\"id\":\"incident-42\"}" : args.logs.output };
    return <div style={{ height: "100dvh" }}><RunnerOverview {...args} logs={logs}
      selected={selected} onSelect={onSelect} /></div>;
  },
} satisfies Meta<typeof RunnerOverview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { logs: { runs: [], output: "", truncated: false } } };
export const Stopped: Story = { args: { status: { ...status, running: false, connected: false, healthy: false, phase: "stopped" } } };
export const Unavailable: Story = { args: { status: undefined, error: "Runner logs are unavailable." } };
