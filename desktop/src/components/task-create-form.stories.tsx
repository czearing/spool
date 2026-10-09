import { useId, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskCreateForm } from "./task-create-form";
import { Dialog, DialogClose } from "./ui/dialog";
import { Button } from "./ui/button";
import { Text } from "./ui/text";

const meta = {
  title: "Tasks/New task", component: TaskCreateForm, parameters: { layout: "centered" },
  args: { id: "new-task-demo", agents: ["software-engineer", "reviewer", "prompt-engineer"],
    pending: false, onSubmit: () => {} },
  render: function Demo(args) {
    const id = useId(), [open, setOpen] = useState(false), [notice, setNotice] = useState("");
    return <><Dialog open={open} onOpenChange={setOpen} title="New task" presentation="composer" trigger={<Button variant="primary">New task</Button>}>
      <TaskCreateForm {...args} id={id} onSubmit={(draft) => { setNotice(`Demo task "${draft.title}" assigned to ${draft.agent}.`); setOpen(false); }}
        actions={<><DialogClose asChild><Button>Cancel</Button></DialogClose><Button type="submit" form={id} variant="primary">Create</Button></>} />
    </Dialog><Text role="status">{notice}</Text></>;
  },
} satisfies Meta<typeof TaskCreateForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Failure: Story = { args: { error: "Spool is offline. Start the project's daemon and retry." } };
export const NoAgents: Story = { args: { agents: [] } };
