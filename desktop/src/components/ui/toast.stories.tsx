import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ComponentProps } from "react";
import { componentPreview } from "../../../.storybook/component-preview";
import { Button } from "./button";
import { Stack } from "./stack";
import { Text } from "./text";
import { Toast, ToastAction, ToastProvider } from "./toast";

function ToastExample(props: ComponentProps<typeof Toast>) {
  const [open, setOpen] = useState(false);
  return <ToastProvider><Button onClick={() => setOpen(true)}>Save changes</Button>
    <Toast {...props} open={open} onOpenChange={setOpen} /></ToastProvider>;
}

const meta = {
  title: "Components/Toast", component: Toast, decorators: [componentPreview],
  args: { title: "Changes saved", description: "Your work item is up to date." },
  render: (args) => <ToastExample {...args} />,
} satisfies Meta<typeof Toast>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const AutoDismiss: Story = { args: { duration: 2000 } };
export const LongContent: Story = { args: { description: "Your changes to this longer work item have been saved. You can continue working without leaving this view." } };
export const Stacked: Story = {
  render: function StackedToasts() {
    const [visible, setVisible] = useState(false);
    return <ToastProvider duration={Infinity}>
      <Button onClick={() => setVisible(true)}>Show notifications</Button>
      {visible && Array.from({ length: 6 }, (_, index) => <Toast key={index} title={`Change ${index + 1} saved`}
        description="Your work item is up to date." />)}
    </ToastProvider>;
  },
};
export const WithAction: Story = {
  render: function UndoToast() {
    const [open, setOpen] = useState(false);
    const [message, setMessage] = useState("No changes");
    return <ToastProvider><Stack align="start"><Button onClick={() => { setMessage("Item archived"); setOpen(true); }}>Archive item</Button>
      <Text role="status">{message}</Text></Stack>
      <Toast title="Item archived" description="You can restore it from the archive." open={open} onOpenChange={setOpen}>
        <ToastAction altText="Undo archiving this work item" onClick={() => setMessage("Item restored")}>Undo</ToastAction>
      </Toast>
    </ToastProvider>;
  },
};
