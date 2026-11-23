import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolUsageView } from "./tool-usage";

const meta = { title: "Home/Tool usage", component: ToolUsageView,
  args: { range: "7d", data: { range: "7d", undated: 0, invalidRecords: 0, recordedSessions: 3, missingSessions: 0, tools: [
    { name: "powershell", action: "Run targeted package tests", calls: 124, timedCalls: 124, totalMs: 190000 },
    { name: "view", action: "Read src\\components\\dashboard.tsx", calls: 93, timedCalls: 93, totalMs: 6500 },
    { name: "bohemia-pr-bohemia_check", action: "Check pull request validation", calls: 12, timedCalls: 11, totalMs: 370000 },
  ] } }, decorators: [(Story) => <div style={{ padding: 24, maxWidth: 900 }}><Story /></div>],
} satisfies Meta<typeof ToolUsageView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { data: { ...meta.args.data, recordedSessions: 0, tools: [] } } };
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Error: Story = { args: { data: undefined, error: "Tool usage is unavailable." } };
export const MissingTiming: Story = { args: { data: { ...meta.args.data,
  tools: [{ name: "powershell", action: "Inspect the current branch", calls: 3, timedCalls: 0, totalMs: null }] } } };
export const PartialData: Story = { args: { data: { ...meta.args.data, invalidRecords: 2 } } };
