import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { componentPreview } from "../../../.storybook/component-preview";
import { Checkbox } from "./checkbox";
import { Stack } from "./stack";
import { Text } from "./text";
import { Button } from "./button";

const meta = { title: "Components/Checkbox", component: Checkbox, decorators: [componentPreview],
  args: { label: "Send me updates", description: "A shared checkbox, independent of the editor." },
} satisfies Meta<typeof Checkbox>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Checked: Story = { args: { defaultChecked: true } };
export const Indeterminate: Story = { args: { defaultChecked: "indeterminate", label: "Select all tasks" } };
export const Disabled: Story = { args: { disabled: true, defaultChecked: true } };
export const Invalid: Story = { args: { required: true, error: "Please confirm before continuing." } };
export const Controlled: Story = {
  render: function ControlledCheckbox() {
    const [checked, setChecked] = useState<boolean | "indeterminate">("indeterminate");
    return <Stack><Checkbox label="Select all tasks" checked={checked} onCheckedChange={setChecked} />
      <Text role="status">{String(checked)}</Text></Stack>;
  },
};
export const Form: Story = {
  render: function CheckboxForm() {
    const [result, setResult] = useState("");
    return <form onSubmit={(event) => {
      event.preventDefault(); setResult(String(new FormData(event.currentTarget).get("updates")));
    }}><Stack>
      <Checkbox label="Send me updates" name="updates" value="subscribed" required />
      <Button type="submit">Save preference</Button><Text role="status">{result}</Text>
    </Stack></form>;
  },
};
