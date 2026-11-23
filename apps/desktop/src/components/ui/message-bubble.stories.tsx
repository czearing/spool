import type { Meta, StoryObj } from "@storybook/react-vite";
import { wideComponentPreview } from "../../../.storybook/component-preview";
import { MessageBubble } from "./message-bubble";
import { demoAnswer } from "./messaging/demo-data";
const meta = {
  title: "Components/Message bubble", component: MessageBubble, decorators: [wideComponentPreview],
  args: { author: "Assistant", markdown: demoAnswer },
} satisfies Meta<typeof MessageBubble>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Outgoing: Story = { args: { author: "You", direction: "outgoing", markdown: "A small message with **important context**." } };
export const Generating: Story = { args: { status: "generating", markdown: "An unfinished **thought" } };
export const Failed: Story = { args: { status: "failed", error: "The response was interrupted. Partial content is preserved." } };
export const UntrustedContent: Story = { args: { markdown: '<script>alert(1)</script>\n\n[Unsafe](javascript:alert%281%29)\n\n![Remote image](https://example.com/tracking.png)\n\n<table><tr><td>HTML</td></tr></table>' } };
