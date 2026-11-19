import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { SettingsDialogView } from "./settings-dialog";
import { Button } from "./ui/button";

const meta = { title: "Settings/Preferences", component: SettingsDialogView,
  args: { open: true, model: "gpt-5.4", options: [{ value: "gpt-5.4", label: "GPT-5.4" }, { value: "auto", label: "Auto" }],
    autopilot: true, onAutopilotChange: () => {},
    onOpenChange: () => {}, onModelChange: () => {}, onSave: () => {}, onReload: () => {} },
  render: function Example(args) {
    const [open, setOpen] = useState(true), [model, setModel] = useState(args.model), [autopilot, setAutopilot] = useState(args.autopilot);
    return <><Button onClick={() => setOpen(true)}>Settings</Button>
      <SettingsDialogView {...args} open={open} model={model} onModelChange={setModel} autopilot={autopilot}
        onAutopilotChange={setAutopilot} onOpenChange={setOpen} onSave={() => setOpen(false)} /></>;
  },
} satisfies Meta<typeof SettingsDialogView>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
export const Agent: StoryObj<typeof meta> = { args: { agent: "engineer", model: null } };
export const ProjectDeletion: StoryObj<typeof meta> = { args: { projectName: "Example", onDeleteProject: () => {} } };
