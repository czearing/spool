import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Archive, BookOpen, Check, Eye, FolderInput, LayoutList, ListTodo, Pencil, Share2 } from "lucide-react";
import { componentPreview } from "../../../.storybook/component-preview";
import { Button } from "./button";
import { DropdownButton } from "./dropdown-button";
import { Menu, MenuTrigger, MenuContent, MenuItem, MenuSub, MenuSubTrigger, MenuSubContent,
  MenuSeparator, MenuLabel, MenuGroup, MenuCheckboxItem, MenuRadioGroup, MenuRadioItem } from "./menu";
import { Stack } from "./stack";
import { Text } from "./text";

const meta = { title: "Components/Menu", component: Menu, decorators: [componentPreview] } satisfies Meta<typeof Menu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: function ActionMenu() {
    const [action, setAction] = useState("No action selected");
    return <Stack align="start"><Menu>
      <MenuTrigger asChild><Button>Work item actions</Button></MenuTrigger>
      <MenuContent>
        <MenuLabel>Work item</MenuLabel>
        <MenuGroup><MenuItem onSelect={() => setAction("Renamed")}>Rename</MenuItem>
          <MenuItem disabled>Share</MenuItem>
          <MenuItem onSelect={() => setAction("Archived")}>Archive</MenuItem></MenuGroup>
      </MenuContent>
    </Menu><Text role="status">{action}</Text></Stack>;
  },
};

export const Nested: Story = {
  render: function NestedMenu(args) {
    const [action, setAction] = useState("No action selected");
    return <Stack align="start"><Menu {...args}>
      <DropdownButton>Work item actions</DropdownButton>
      <MenuContent>
        <MenuItem onSelect={() => setAction("Opened")}>Open</MenuItem>
        <MenuSub><MenuSubTrigger>Move to</MenuSubTrigger><MenuSubContent>
          <MenuSub><MenuSubTrigger>Planning</MenuSubTrigger><MenuSubContent>
            <MenuItem onSelect={() => setAction("Moved to Backlog")}>Backlog</MenuItem>
            <MenuItem onSelect={() => setAction("Moved to In progress")}>In progress</MenuItem>
          </MenuSubContent></MenuSub>
          <MenuItem onSelect={() => setAction("Moved to Completed")}>Completed</MenuItem>
        </MenuSubContent></MenuSub>
        <MenuSeparator />
        <MenuItem disabled>Delete permanently</MenuItem>
      </MenuContent>
    </Menu><Text role="status">{action}</Text></Stack>;
  },
};

export const RightToLeft: Story = { ...Nested, args: { dir: "rtl" } };

export const WithIcons: Story = {
  render: function IconMenu() {
    const [action, setAction] = useState("No action selected");
    return <Stack align="start"><Menu>
      <DropdownButton>Work item actions</DropdownButton><MenuContent>
        <MenuItem icon={<Pencil />} onSelect={() => setAction("Renamed")}>Rename</MenuItem>
        <MenuItem icon={<Share2 />} disabled>Share</MenuItem>
        <MenuSub><MenuSubTrigger icon={<FolderInput />}>Move to</MenuSubTrigger><MenuSubContent>
          <MenuItem icon={<ListTodo />} onSelect={() => setAction("Moved to Backlog")}>Backlog</MenuItem>
          <MenuItem icon={<Check />} onSelect={() => setAction("Moved to Completed")}>Completed</MenuItem>
        </MenuSubContent></MenuSub>
        <MenuSeparator />
        <MenuItem icon={<Archive />} onSelect={() => setAction("Archived")}>Archive</MenuItem>
        <MenuItem asChild icon={<BookOpen />}><a href="#guide">Read guide</a></MenuItem>
      </MenuContent>
    </Menu><Text role="status">{action}</Text></Stack>;
  },
};

export const Selection: Story = {
  render: function SelectionMenu() {
    const [details, setDetails] = useState(true);
    const [density, setDensity] = useState("comfortable");
    return <Stack align="start"><Menu>
      <DropdownButton>View options</DropdownButton><MenuContent>
        <MenuCheckboxItem icon={<Eye />} checked={details} onCheckedChange={(checked) => setDetails(checked === true)}>Show details</MenuCheckboxItem>
        <MenuSeparator /><MenuLabel>Density</MenuLabel>
        <MenuRadioGroup value={density} onValueChange={setDensity}>
          <MenuRadioItem icon={<LayoutList />} value="comfortable">Comfortable</MenuRadioItem>
          <MenuRadioItem icon={<ListTodo />} value="compact">Compact</MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu><Text role="status">{details ? "Details shown" : "Details hidden"}; {density}</Text></Stack>;
  },
};
