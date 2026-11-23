import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { FilePlus, FolderOpen, Archive } from "lucide-react";
import { componentPreview } from "../../../.storybook/component-preview";
import { CommandList, CommandItem, CommandEmpty } from "./command-list";
import { Menu, MenuTrigger, MenuContent, MenuItem } from "./menu";
import { Button } from "./button";
import { Text } from "./text";
import { Stack } from "./stack";

const meta = { title: "Components/CommandList", component: CommandList, decorators: [componentPreview],
  args: { label: "Actions" }, parameters: { docs: { description: {
    component: "Shared command presentation. Compose with Radix Menu for actions or Lexical Typeahead for editor suggestions; the owner supplies keyboard behavior and ARIA semantics.",
  } } },
} satisfies Meta<typeof CommandList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  render: function ActionMenu() {
    const [selected, setSelected] = useState("No action selected");
    return <Stack><Menu modal={false}><MenuTrigger asChild><Button>Actions</Button></MenuTrigger>
      <MenuContent asChild><CommandList label="Actions">
        <MenuItem asChild onSelect={() => setSelected("Created document")}><CommandItem icon={<FilePlus />} description="Start a new draft">Create document</CommandItem></MenuItem>
        <MenuItem asChild disabled><CommandItem icon={<Archive />} description="Unavailable for this item">Archive</CommandItem></MenuItem>
        <MenuItem asChild onSelect={() => setSelected("Opened project")}><CommandItem icon={<FolderOpen />} description="Return to your workspace">Open project</CommandItem></MenuItem>
      </CommandList></MenuContent>
    </Menu><Text role="status">{selected}</Text></Stack>;
  },
};
export const Empty: Story = { render: () => <CommandList label="Actions"><CommandEmpty /></CommandList> };
