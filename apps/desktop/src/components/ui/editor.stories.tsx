import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState, Profiler } from "react";
import { wideComponentPreview } from "../../../.storybook/component-preview";
import { Editor, type EditorHandle } from "./editor";
import { Button } from "./button";
import { Stack } from "./stack";
import { Text } from "./text";
import { Textarea } from "./textarea";
import styles from "./editor.stories.module.css";

const sample = `# A little room to think

Turn a rough idea into something clear. Start writing, use **Markdown**, or type \`/\` to choose a block.

## Make the next step obvious

- Keep the important context close
- Give each idea a little breathing room
- Link to [the project](https://example.com)

- [x] Find a direction
- [ ] Write the first draft
- [ ] Share it for feedback

> Good writing makes the next action easier.

:::callout
**Keep it simple.** Everything here is editable, including this callout.
:::

:::toggle Details worth keeping
Supporting notes belong here, without interrupting the main idea.
:::

### A small example

\`\`\`typescript
const nextStep = "Make something useful";
console.log(nextStep);
\`\`\`

| Task | Status |
| --- | --- |
| Explore | Complete |
| Refine | In progress |

---

Try selecting a sentence, or insert a new block below.
`;
const meta = {
  title: "Components/Editor", component: Editor, decorators: [wideComponentPreview],
  args: { label: "Document", initialMarkdown: sample },
  parameters: { docs: { description: { component: "A standalone Lexical writing surface. Markdown shortcuts, slash commands, block actions, tables, images, callouts and toggles. No board integration or persistence is implied." } } },
} satisfies Meta<typeof Editor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Document: Story = { args: { presentation: "document" } };
export const Empty: Story = { args: { initialMarkdown: "" } };
export const ReadOnly: Story = { args: { readOnly: true } };
export const Scrollable: Story = { render: () => <div className={styles.scroll} role="region" aria-label="Scrollable document">
  <Editor label="Document" initialMarkdown={sample} />
</div> };
export const MarkdownRoundTrip: Story = {
  render: function MarkdownRoundTrip() {
    const editor = useRef<EditorHandle>(null), [markdown, setMarkdown] = useState(sample);
    return <Stack gap={4}>
      <Editor ref={editor} label="Document" initialMarkdown={sample} />
      <Stack direction="row" gap={2}>
        <Button onClick={() => setMarkdown(editor.current!.getMarkdown())}>Export Markdown</Button>
        <Button onClick={() => editor.current!.setMarkdown(markdown)}>Load Markdown</Button>
      </Stack>
      <Textarea label="Markdown source" value={markdown} onChange={(event) => setMarkdown(event.target.value)} />
    </Stack>;
  },
};
export const LongDocument: Story = { args: {
  initialMarkdown: Array.from({ length: 400 }, (_, i) => `## Section ${i + 1}\n\nA focused paragraph with **important context** and a clear next action.`).join("\n\n"),
} };
export const IndependentEditors: Story = { render: () => <Stack gap={6}>
  <Editor label="First document" initialMarkdown="First document" /><Editor label="Second document" initialMarkdown="Second document" />
</Stack> };
export const ChangeNotifications: Story = {
  render: function ChangeNotifications() {
    const commits = useRef(0), [markdown, setMarkdown] = useState(""), [reported, setReported] = useState(0);
    return <Stack gap={3}>
      <Profiler id="editor" onRender={() => { commits.current++; }}>
        <Editor label="Document" onMarkdownChange={setMarkdown} />
      </Profiler>
      <Text variant="meta" role="status">{markdown.length} exported Markdown characters</Text>
      <Button onClick={() => setReported(commits.current)}>Inspect React commits</Button>
      <Text variant="meta">Commits: {reported}</Text>
    </Stack>;
  },
};
