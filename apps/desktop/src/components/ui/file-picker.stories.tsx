import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { componentPreview } from "../../../.storybook/component-preview";
import { browseLocalPath } from "../../lib/local-file-picker";
import { Button } from "./button";
import { FilePicker } from "./file-picker";
import { Stack } from "./stack";
import { Text } from "./text";

const meta = {
  title: "Components/FilePicker", component: FilePicker, decorators: [componentPreview],
  args: { label: "File", placeholder: "Choose a file or enter its path",
    description: "Browse opens the Windows picker on this computer. The local app must be running.",
    onBrowse: (signal) => browseLocalPath("file", signal) },
} satisfies Meta<typeof FilePicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Folder: Story = { args: { label: "Folder", kind: "folder", placeholder: "Choose a folder or enter its path",
  onBrowse: (signal) => browseLocalPath("folder", signal) } };
export const Disabled: Story = { args: { disabled: true, defaultValue: "C:\\Projects\\requirements.md" } };
export const ReadOnly: Story = { args: { readOnly: true, defaultValue: "C:\\Projects\\requirements.md" } };
export const Invalid: Story = { args: { required: true, error: "Choose an existing file." } };
export const Unavailable: Story = { args: { onBrowse: async () => { throw new Error("Picker unavailable. Enter the path instead."); } } };
export const Controlled: Story = {
  render: function ControlledPicker(args) {
    const [value, setValue] = useState("");
    return <Stack><FilePicker {...args} value={value} onValueChange={setValue} />
      <Text role="status">{value || "Nothing selected"}</Text><Button onClick={() => setValue("")}>Clear</Button></Stack>;
  },
};
export const Form: Story = {
  render: function PickerForm(args) {
    const [saved, setSaved] = useState("");
    return <Stack asChild><form onSubmit={(event) => {
      event.preventDefault(); setSaved(String(new FormData(event.currentTarget).get("path")));
    }}>
      <FilePicker {...args} name="path" required /><Button type="submit">Save</Button>
      <Text role="status">{saved || "Not saved"}</Text>
    </form></Stack>;
  },
};
