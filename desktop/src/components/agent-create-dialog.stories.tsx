import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { AgentCreateDialogView } from "./agent-create-dialog";
import { Button } from "./ui/button";

const meta = { title: "Agents/Create agent", component: AgentCreateDialogView, parameters: { layout: "centered" },
  args: { options: [{ value: "gpt-5.4", label: "GPT-5.4" }], onCreate: () => {} },
} satisfies Meta<typeof AgentCreateDialogView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { render: (args) => {
  const [open, setOpen] = useState(true);
  return <><Button onClick={() => setOpen(true)}>Create agent</Button><AgentCreateDialogView {...args} open={open} onOpenChange={setOpen} /></>;
} };
export const Saving: Story = { args: { open: true, pending: true } };
export const Error: Story = { args: { open: true, error: "This agent already exists. Choose another name." } };
