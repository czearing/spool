import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot } from "lexical";
import { describe, expect, it } from "vitest";
import { chatNodes, $importChatMarkdown, $exportChatMarkdown } from "../components/ui/messaging/chat-markdown";

function document(markdown: string) {
  const editor = createHeadlessEditor({ namespace: "chat-test", nodes: chatNodes, onError: (error) => { throw error; } });
  editor.update(() => $importChatMarkdown(markdown), { discrete: true });
  return { text: () => editor.getEditorState().read(() => $getRoot().getTextContent()),
    output: () => editor.getEditorState().read($exportChatMarkdown) };
}
describe("chat Markdown subset", () => {
  it.each([
    "A **bold**, *italic*, ~~struck~~ and `code` thought.",
    "- First\n    - Nested\n- Last\n\n1. First\n2. Second",
    "> A quoted thought\n\nAnother paragraph.",
    "[Useful link](https://example.com/docs)",
    "```typescript\nconst one = 1;\n\n  const two = 2;\n```",
    "First line\nSecond line\n\nLast paragraph.",
  ])("preserves content through repeated round trips: %s", (source) => {
    const first = document(source);
    expect(document(first.output()).output()).toBe(first.output());
    expect(document(first.output()).text()).toBe(first.text());
  });
  it("preserves Windows code whitespace", () => {
    expect(document("```\r\n  first\r\n\r\n    second\r\n```").output()).toContain("  first\n\n    second");
  });
  it("keeps unsupported blocks readable instead of creating document-editor nodes", () => {
    const source = "# Heading\n\n:::callout\nKeep me\n:::\n\n| A | B |\n| - | - |";
    const result = document(source);
    expect(result.text()).toContain("# Heading");
    expect(result.text()).toContain(":::callout");
    expect(result.text()).toContain("| A | B |");
  });
});
