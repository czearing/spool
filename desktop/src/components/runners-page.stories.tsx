import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunnersPageView } from "./runners-page";
import type { Runner } from "../lib/runners";

const runner: Runner = { id: "pr-reviewer", enabled: true, connected: true, running: true, healthy: true,
  stopping: false, phase: "ready", lastRunAt: "2026-10-02T23:00:00Z", lastSuccessAt: "2026-10-02T23:00:00Z", lastRunFailed: false,
  script: "runners\\pr-reviewer\\run.mjs", intervalSeconds: 60, activeIntervalSeconds: 60, error: null,
  repository: { mode: "on-demand", state: "succeeded", lastUpdatedAt: "2026-10-02T22:40:00Z", lastAttemptAt: "2026-10-02T22:39:00Z", error: null } };
const meta = { title: "Runners/List", component: RunnersPageView, parameters: { layout: "fullscreen" },
  args: { onRetry: () => {}, data: { checkedAt: "2026-10-02T23:01:00Z", configured: true, runners: [
    runner, { ...runner, id: "livesite", script: "runners\\livesite\\run.mjs", intervalSeconds: 300, activeIntervalSeconds: 300,
      phase: "scanning", repository: { ...runner.repository, state: "updating" } },
    { ...runner, id: "pr-updater", script: "runners\\pr-updater\\run.mjs", healthy: false, phase: "degraded", lastRunFailed: true,
      error: "Dependency installation failed. Check the local preparation log.",
      repository: { ...runner.repository, state: "failed", error: "Dependency installation failed. Check the local preparation log." } },
  ] } },
} satisfies Meta<typeof RunnersPageView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { data: { checkedAt: "2026-10-02T23:01:00Z", configured: false, runners: [] } } };
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Unrecorded: Story = { args: { data: { checkedAt: "2026-10-02T23:01:00Z", configured: true, runners: [
  { ...runner, repository: { ...runner.repository, state: "unknown", lastUpdatedAt: null, lastAttemptAt: null } },
] } } };
export const Offline: Story = { args: { data: { checkedAt: "2026-10-02T23:01:00Z", configured: true, runners: [
  { ...runner, connected: false, running: false, healthy: false, phase: "stopped", activeIntervalSeconds: null },
] } } };
export const Error: Story = { args: { error: "Runner status is unavailable. Connection and activity could not be verified." } };
