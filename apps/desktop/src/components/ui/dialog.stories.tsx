import type { Meta, StoryObj } from "@storybook/react-vite";
import { useId, useState } from "react";
import { componentPreview } from "../../../.storybook/component-preview";
import { Button } from "./button";
import { Dialog, DialogClose } from "./dialog";
import { Dropdown } from "./dropdown";
import { Input } from "./input";
import { Stack } from "./stack";
import { Text } from "./text";
import { Textarea } from "./textarea";
import { Tooltip, TooltipProvider } from "./tooltip";

const meta = {
  title: "Components/Dialog", component: Dialog, decorators: [componentPreview],
  args: {
    trigger: <Button>Edit work item</Button>, title: "Edit work item",
    description: "Keep the title clear and the next step actionable.",
    children: <Stack><Input label="Title" defaultValue="Review keyboard navigation" />
      <Textarea label="Description" defaultValue="Check focus order and keyboard shortcuts." /></Stack>,
    footer: <DialogClose asChild><Button variant="primary">Done</Button></DialogClose>,
  },
} satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithoutDescription: Story = { args: { description: undefined } };
export const Controlled: Story = {
  render: function EditDialog() {
    const [open, setOpen] = useState(false);
    const [saved, setSaved] = useState("");
    const form = useId();
    return <Stack align="start">
      <Dialog trigger={<Button>Edit work item</Button>} title="Edit work item" open={open} onOpenChange={setOpen}
        footer={<><DialogClose asChild><Button>Cancel</Button></DialogClose>
          <Button type="submit" form={form} variant="primary">Save changes</Button></>}>
        <form id={form} onSubmit={(event) => {
          event.preventDefault();
          setSaved(String(new FormData(event.currentTarget).get("title")));
          setOpen(false);
        }}><Input label="Title" name="title" defaultValue={saved || "Review keyboard navigation"} required /></form>
      </Dialog>
      <Text role="status">{saved ? `Saved: ${saved}` : "No changes saved"}</Text>
    </Stack>;
  },
};
export const NestedOverlays: Story = {
  args: {
    children: <TooltipProvider><Stack>
      <Input label="Title" defaultValue="Review keyboard navigation" />
      <Dropdown label="Status" defaultValue="backlog" options={[{ value: "backlog", label: "Backlog" }, { value: "completed", label: "Completed" }]} />
      <Tooltip content="Changes remain local until you save."><Button>About this change</Button></Tooltip>
    </Stack></TooltipProvider>,
  },
};
export const LongContent: Story = {
  args: { children: <Stack>{Array.from({ length: 12 }, (_, index) => <Text asChild key={index}><p>
    Keep this description clear and actionable. Long content scrolls within the dialog without overflowing the page.
  </p></Text>)}</Stack> },
};
