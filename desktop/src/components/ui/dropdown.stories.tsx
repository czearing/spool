import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { componentPreview } from "../../../.storybook/component-preview";
import { Button } from "./button";
import { Dropdown } from "./dropdown";
import { Stack } from "./stack";
import { Text } from "./text";

const options = [
  { value: "backlog", label: "Backlog" }, { value: "in-progress", label: "In progress" },
  { value: "completed", label: "Completed" }, { value: "blocked", label: "Blocked", disabled: true },
];
const meta = {
  title: "Components/Dropdown", component: Dropdown, decorators: [componentPreview],
  args: { label: "Status", placeholder: "Choose a status", options },
} satisfies Meta<typeof Dropdown>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true, defaultValue: "backlog" } };
export const Invalid: Story = { args: { error: "Choose a status to continue.", required: true } };
export const LongOptions: Story = {
  args: { options: Array.from({ length: 50 }, (_, index) => ({ value: String(index), label: `Project ${index + 1}` })) },
};
export const Controlled: Story = {
  render: function ControlledDropdown() {
    const [value, setValue] = useState("backlog");
    return <Stack><Dropdown label="Status" options={options} value={value} onValueChange={setValue} />
      <Text role="status">Selected: {value}</Text><Button onClick={() => setValue("")}>Clear selection</Button></Stack>;
  },
};
export const Form: Story = {
  render: function StatusForm() {
    const [saved, setSaved] = useState("");
    return <Stack asChild><form onSubmit={(event) => {
      event.preventDefault();
      setSaved(String(new FormData(event.currentTarget).get("status")));
    }}>
      <Dropdown label="Status" name="status" required options={options} />
      <Button type="submit">Save status</Button><Text role="status">{saved || "Not saved"}</Text>
    </form></Stack>;
  },
};
