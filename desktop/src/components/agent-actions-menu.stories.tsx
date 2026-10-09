import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentActionsMenu } from "./agent-actions-menu";
import { Text } from "./ui/text";
import { SettingsDialogView } from "./settings-dialog";

const meta = {
  title: "Agents/Actions", component: AgentActionsMenu, parameters: { layout: "centered" },
  args: { agent: "software-engineer", editLink: <a href="#prompt">Edit prompt</a>, onDelete: () => {} },
  render: function Demo(args) {
    const [deleted, setDeleted] = useState(false), [model, setModel] = useState<string | null>(null);
    return deleted ? <Text role="status">Demo agent deleted. Job history is unchanged.</Text>
      : <AgentActionsMenu {...args} onDelete={() => { if (!args.error) setDeleted(true); }}
        settings={(props) => <SettingsDialogView {...props} agent={args.agent} model={model}
          options={[{ value: "gpt-5.4", label: "GPT-5.4" }]} onModelChange={setModel} onReload={() => {}}
          onSave={() => props.onOpenChange(false)} />} />;
  },
} satisfies Meta<typeof AgentActionsMenu>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const PendingWork: Story = { args: { error: "This agent has queued or in-progress work. Finish or reassign that work before deleting it." } };
