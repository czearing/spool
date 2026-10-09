import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { AgentSettingsFields, type AgentFields } from "./agent-settings-fields";

const meta = { title: "Agents/Settings", component: AgentSettingsFields, parameters: { layout: "padded" },
  args: { value: { image: null, maxConcurrentRuns: 1 }, onChange: () => {} },
} satisfies Meta<typeof AgentSettingsFields>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { render: (args) => {
  const [value, setValue] = useState<AgentFields>(args.value);
  return <AgentSettingsFields {...args} value={value} onChange={(change) => setValue((value) => ({ ...value, ...change }))} />;
} };
export const Unlimited: Story = { args: { value: { image: null, maxConcurrentRuns: null } } };
