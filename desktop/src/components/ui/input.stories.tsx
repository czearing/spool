import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { componentPreview } from "../../../.storybook/component-preview";
import { Button } from "./button";
import { Input } from "./input";
import { Stack } from "./stack";
import { Text } from "./text";

const meta = {
  title: "Components/Input", component: Input, decorators: [componentPreview],
  args: { label: "Work item", placeholder: "Give this item a clear title", description: "Use a short, actionable title." },
} satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Compact: Story = { args: { density: "compact", labelHidden: true, description: undefined } };
export const Disabled: Story = { args: { disabled: true, defaultValue: "Review requirements" } };
export const ReadOnly: Story = { args: { readOnly: true, defaultValue: "Review requirements" } };
export const Invalid: Story = { args: { error: "Enter a work item title.", required: true } };
export const Controlled: Story = {
  render: function ControlledInput() {
    const [value, setValue] = useState("");
    const input = useRef<HTMLInputElement>(null);
    return <Stack><Input label="Work item" ref={input} value={value} onChange={(event) => setValue(event.target.value)}
      aria-describedby="title-guidance" /><Text id="title-guidance">Keep the title specific.</Text>
      <Text role="status">{value || "No title yet"}</Text><Button onClick={() => input.current?.focus()}>Focus title</Button></Stack>;
  },
};
export const Form: Story = {
  render: function WorkItemForm() {
    const [saved, setSaved] = useState("");
    return <Stack asChild><form onSubmit={(event) => {
      event.preventDefault();
      setSaved(String(new FormData(event.currentTarget).get("title")));
    }}>
      <Input label="Work item" name="title" required minLength={3} autoComplete="off" />
      <Button type="submit" variant="primary">Save item</Button>
      <Text role="status">{saved ? `Saved: ${saved}` : "Not saved"}</Text>
    </form></Stack>;
  },
};
