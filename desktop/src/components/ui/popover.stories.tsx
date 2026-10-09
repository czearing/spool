import type { Meta, StoryObj } from "@storybook/react-vite";
import { componentPreview } from "../../../.storybook/component-preview";
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from "./popover";
import { Button } from "./button";
import { Input } from "./input";
import { Stack } from "./stack";
import { Text } from "./text";

const meta = { title: "Components/Popover", component: Popover, decorators: [componentPreview] } satisfies Meta<typeof Popover>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  render: () => <Popover><PopoverTrigger asChild><Button>Quick edit</Button></PopoverTrigger>
    <PopoverContent label="Quick edit"><Stack>
      <Text variant="heading">Edit a work item</Text><Input label="Work item" defaultValue="Review the draft" />
      <PopoverClose asChild><Button>Done</Button></PopoverClose>
    </Stack></PopoverContent>
  </Popover>,
};
