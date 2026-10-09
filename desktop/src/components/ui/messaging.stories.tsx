import type { Meta, StoryObj } from "@storybook/react-vite";
import { wideComponentPreview } from "../../../.storybook/component-preview";
import { MessagingDemo } from "./messaging/messaging-demo";
import { historyMessages, demoAnswer } from "./messaging/demo-data";
import styles from "./messaging/messaging-demo.module.css";
import { PerformanceDemo } from "./messaging/performance-demo";

const meta = {
  title: "Components/Messaging", component: MessagingDemo, decorators: [wideComponentPreview],
  parameters: { docs: { description: { component: "A local, deterministic conversation. No backend, persistence, uploads or model calls. Send a message to stream a response; keep typing while it arrives." } } },
} satisfies Meta<typeof MessagingDemo>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { initial: [] } };
export const BasicMarkdown: Story = { args: { initial: [{ id: "markdown", author: "Assistant", markdown: demoAnswer }],
  initialDraft: "**An idea** with `code`\n\n- A first step\n- A second step" } };
export const StreamingWhileTyping: Story = { args: { initialDraft: "Help me find the next step." } };
export const SendFailureRetry: Story = { args: { failFirst: true, initialDraft: "Keep this draft safe." } };
export const StoppedResponse: Story = { args: { initial: [{ id: "stopped", author: "Assistant", markdown: demoAnswer.slice(0, 160), status: "stopped" }] } };
export const LongHistory: Story = { args: { initial: historyMessages(500) } };
export const Stress: Story = { args: { initial: historyMessages(1000), initialDraft: "Draft context. ".repeat(720) } };
export const NarrowViewport: Story = { render: () => <div className={styles.narrow}><MessagingDemo /></div> };
export const ConversationSwitch: Story = { args: { initial: [], switchable: true } };
export const Performance100: Story = { render: () => <PerformanceDemo count={100} /> };
export const Performance500: Story = { render: () => <PerformanceDemo count={500} /> };
export const Performance1000: Story = { render: () => <PerformanceDemo /> };
