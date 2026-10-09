import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { componentPreview } from "../../../.storybook/component-preview";
import { Stack } from "./stack";
import { Text } from "./text";
import { Textarea } from "./textarea";

const meta = {
  title: "Components/Textarea", component: Textarea, decorators: [componentPreview],
  args: { label: "Description", placeholder: "Add the context needed to move this work forward.", description: "Plain text. Keep the next step clear." },
} satisfies Meta<typeof Textarea>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true, defaultValue: "Waiting for feedback." } };
export const ReadOnly: Story = { args: { readOnly: true, defaultValue: "Review the keyboard navigation.\nRecord any gaps." } };
export const Invalid: Story = { args: { error: "Add a description before continuing.", required: true } };
export const Controlled: Story = {
  render: function ControlledTextarea() {
    const [value, setValue] = useState("");
    return <Stack><Textarea label="Description" value={value} onChange={(event) => setValue(event.target.value)} maxLength={200} />
      <Text variant="meta" tone="secondary" tabular>{value.length} / 200</Text></Stack>;
  },
};
