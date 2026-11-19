import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState } from "react";
import type { TaskConversation } from "../lib/task-conversation";
import { TaskChatView } from "./task-chat-view";
import { Dropdown } from "./ui/dropdown";
import styles from "./chat-reading-preview.module.css";

const report = `## The fix is ready

**The duplicate fetch was caused by a second subscription, not by the cache.** I removed the redundant listener and kept the existing retry behavior.

The change stays inside the conversation loader.
Navigation, pagination, and reconnect behavior are unchanged.

### What changed

- Reused the existing request lifecycle instead of introducing another helper.
- Preserved cancellation when you switch conversations.
- Checked the two cases that made the original failure intermittent:
  - Opening a conversation while the connection is recovering.
  - Loading older messages before the first request finishes.

### Validation

| Check | Before | After | Notes |
| :--- | ---: | ---: | :--- |
| Initial requests | 2 | 1 | One shared subscription |
| Targeted tests | 12 / 14 | 14 / 14 | Both regression cases pass |
| Reconnect requests | 1 | 1 | Existing behavior preserved |
| Type errors | 0 | 0 | No public API changes |

These are **illustrative preview results**, not measurements from this repository. The table deliberately mixes text and numeric columns so alignment and wrapping can be judged together.

> Keep the lifecycle in one place. A second subscriber should observe the same request, not create a competing one.

### Implementation detail

The listener now uses \`subscribeToConversation(taskId)\`; the unsubscribe function still runs when the active task changes.

\`\`\`ts
const unsubscribe = subscribeToConversation(taskId, {
  onMessage: appendMessage,
  onReconnect: refreshConversation,
});

return () => unsubscribe();
\`\`\`

### References and limitations

This preview uses the same sanitized Markdown renderer as the app. Links such as [Quarto's table documentation](https://quarto.org/docs/authoring/tables.html) remain ordinary links; there are no new citation popups, fonts, or dependencies.

---

**Bottom line:** one listener, the same behavior, and focused regression coverage.`;

const wideTable = `## Comparing the options

This intentionally wide table should scroll inside the message, not stretch the chat or squeeze every word into a narrow column.

| Approach | Ownership | Initial requests | Reconnect requests | Cancellation | Failure handling | Decision |
| :--- | :--- | ---: | ---: | :--- | :--- | :--- |
| Shared subscription | Existing lifecycle | 1 | 1 | Preserved on navigation | Existing retry path | Recommended |
| Separate subscriber | Second lifecycle | 2 | 2 | Requires extra coordination | Can race with the first request | Avoid |
| New cache layer | New abstraction | 1 | 1 | Must be implemented again | Duplicates existing behavior | Out of scope |

All values are illustrative. The long identifier \`conversation_subscription_reconnect_generation_20261102\` and this long path should wrap without breaking the layout:

\`C:\\\\workspace\\\\packages\\\\conversation-loader\\\\src\\\\subscriptions\\\\reconnect-generation-handler.ts\`

### Follow-up

1. Keep the existing owner.
2. Add the two regression cases.
3. Confirm that navigation still cancels the subscription.`;

const shortReply = `Fixed the duplicate subscription in \`conversation-loader.ts\`.

The reconnect path is unchanged. **Both regression cases pass**, and TypeScript is clean.`;

const samples = { report, "wide-table": wideTable, "short-reply": shortReply };
type Sample = keyof typeof samples;
const conversation = (sample: Sample, historyCount: number): TaskConversation => ({
  task: { id: "reading-preview", title: "Fix the duplicate conversation request", agent: "software-engineer",
    status: "completed", prompt: "Fix the duplicate request and explain what changed.", createdAt: "2026-11-02T14:00:00Z" },
  entries: [
    ...Array.from({ length: historyCount }, (_, index) => ({
      kind: index % 2 ? "assistant" : "user", ts: "2026-11-02T14:01:00Z", id: `history-${index}`,
      text: `Message ${index + 1}. Keep the context close, and make the next action clear.`,
    })),
    { kind: "assistant", ts: "2026-11-02T14:02:00Z", text: samples[sample] },
  ],
  available: true, limited: false, nextBefore: null, cursor: 2, canSend: true, readOnlyReason: "", activity: "completed",
});

function ReadingPreview({ historyCount = 0 }: { historyCount?: number }) {
  const [sample, setSample] = useState<Sample>("report");
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      for (const viewport of root.current?.querySelectorAll<HTMLElement>('[aria-label="Task conversation"]') ?? []) viewport.scrollTop = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [sample]);
  return <main ref={root} className={styles.preview}>
    <header className={styles.intro}>
      <h1>A quieter reading experience</h1>
      <p>Approved styling through shared Text and Markdown components: the same chat, renderer, font, and controls, with more readable prose and quieter tables. This fixture sends no messages.</p>
      <div className={styles.controls}>
        <Dropdown label="Content" density="compact" value={sample} onValueChange={value => setSample(value as Sample)}
          options={[{ value: "report", label: "Detailed reply" }, { value: "wide-table", label: "Wide table" },
            { value: "short-reply", label: "Short reply" }]} />
      </div>
    </header>
    <div className={styles.panels}><section className={styles.panel} aria-label="Approved chat">
      <h2>Approved</h2>
      <div className={styles.chat}><TaskChatView key={sample} data={conversation(sample, historyCount)} onRetry={() => {}}
        composer={{ label: "Preview message", placeholder: "Local preview - no messages are sent", onSubmit: async () => {} }} /></div>
    </section></div>
    <details className={styles.notes}>
      <summary>Design rationale and sources</summary>
      <p>Gwern's long-form research site prioritizes restrained typography and progressive enhancement. Quarto keeps tables semantic and supports deliberate alignment. Butterick recommends shorter reading lines, less table-border noise, and more space inside cells.</p>
      <p>For this chat: 16px prose at 1.65 line height, a 68ch prose measure, larger section breaks, modest headings, 14px tables with horizontal rules, right-aligned tabular digits, and keyboard-focusable table scrolling. Controls and user messages stay compact. No serif font, justification, decorative citations, or extra badges.</p>
      <p>The shared reading style restores explicit paragraph spacing instead of only enlarging the text. Rendering, sanitization, streaming, and chat virtualization are unchanged; the change adds no dependencies or font downloads.</p>
      <p><a href="https://gwern.net/design" target="_blank" rel="noopener noreferrer">Gwern: site design</a>{" / "}
        <a href="https://quarto.org/docs/authoring/tables.html" target="_blank" rel="noopener noreferrer">Quarto: tables</a>{" / "}
        <a href="https://practicaltypography.com/line-length.html" target="_blank" rel="noopener noreferrer">Butterick: line length</a>{" / "}
        <a href="https://practicaltypography.com/tables.html" target="_blank" rel="noopener noreferrer">Butterick: tables</a></p>
    </details>
  </main>;
}

const meta = { title: "Tasks/Reading preview", component: ReadingPreview, parameters: { layout: "fullscreen" } } satisfies Meta<typeof ReadingPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Proposed: Story = {};
export const Comparison: Story = {};
export const LongHistory: Story = { args: { historyCount: 1000 } };
