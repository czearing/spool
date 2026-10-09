import type { ChatMessage } from "../message-history";

export type DemoMessage = ChatMessage;
export const demoAnswer = `A small, dependable messaging surface fits this workspace.

**Keep the important parts close:**

- A quiet message bubble
- Markdown where it helps
- A draft that survives a failed send

\`\`\`typescript
const message = { status: "accepted" };
\`\`\`

> Your next thought should never have to wait for the previous response.

Try typing while this response arrives.`;

export const initialMessages: DemoMessage[] = [
  { id: "intro-user", author: "You", direction: "outgoing", markdown: "Let's make messaging feel at home here." },
  { id: "intro-assistant", author: "Assistant", markdown: "A quiet place to work through an idea. Write a message below; **Markdown** and `code` are welcome." },
];
export function historyMessages(count: number): DemoMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `history-${index}`, author: index % 2 ? "Assistant" : "You",
    direction: index % 2 ? "incoming" : "outgoing",
    markdown: `Message ${index + 1}. Keep the context close, and make the next action clear.`,
  }));
}
