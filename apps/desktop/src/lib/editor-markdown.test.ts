import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { $convertToMarkdownString } from "@lexical/markdown";
import { describe, expect, it } from "vitest";
import { editorNodes } from "../components/ui/editor/editor-theme";
import { $importMarkdown, markdownTransformers } from "../components/ui/editor/markdown";
import { safeEditorUrl } from "../components/ui/editor/urls";

function document(markdown: string) {
  const editor = createHeadlessEditor({ namespace: "test", nodes: editorNodes, onError: (error) => { throw error; } });
  editor.update(() => $importMarkdown(markdown), { discrete: true });
  return { editor, export: () => editor.getEditorState().read(() => $convertToMarkdownString(markdownTransformers)) };
}
describe("editor Markdown", () => {
  it("normalizes Windows line endings before asynchronous code highlighting can change the document", () => {
    const output = document("# Prompt\r\n\r\n```\r\nFirst line\r\nSecond line\r\n```\r\n").export();
    expect(output).not.toContain("\r");
    expect(output).toContain("```\nFirst line\nSecond line\n```");
    expect(document(output).export()).toBe(output);
  });
  it.each([
    "# Heading\n\nA **bold**, *italic*, ~~struck~~, ==highlighted== and `code` sentence.",
    "- First\n    - Nested\n- Last\n\n1. One\n2. Two\n\n- [x] Done\n- [ ] Open",
    "> A useful quote\n\n---\n\n```typescript\nconst ready = true;\n```",
    "[Link](https://example.com)\n\n![Description](/preview.png)",
    "| Name | Value |\n| --- | :---: |\n| **Bold** | One |\n| A\\|B | Two |",
    "Name | Value\n--- | ---\nOne | Two",
    "<u>**Important**</u> and ![A \\[draft\\] diagram](/diagram.png)",
    ":::callout\n**Note:** keep this.\n:::\n\n:::toggle More details\nA paragraph.\n:::",
  ])("is stable through repeated import/export: %s", (source) => {
    const output = document(source).export();
    expect(document(output).export()).toBe(output);
    expect(output).not.toContain("undefined");
  });
  it("preserves rich table content and escaped delimiters", () => {
    const { editor, export: output } = document("| Name | Value |\n| --- | ---: |\n| **Bold** | A\\|B<br>next |");
    expect(output()).toContain("**Bold**");
    expect(output()).toContain("A\\|B<br>next");
    editor.getEditorState().read(() => expect($getRoot().getFirstChild()?.getType()).toBe("table"));
  });
  it("preserves JSON document structure", () => {
    const original = document(":::toggle Notes\n- [ ] Task\n:::\n\n:::callout\nA note\n:::");
    const loaded = document("");
    loaded.editor.setEditorState(loaded.editor.parseEditorState(original.editor.getEditorState().toJSON()));
    expect(loaded.export()).toBe(original.export());
  });
  it("preserves checked and unchecked state when adapting Lexical list items", () => {
    const original = document("- [x] Finished\n- [ ] Pending");
    expect(original.export()).toContain("- [x] Finished");
    expect(original.export()).toContain("- [ ] Pending");
  });
  it("preserves underline using the documented inline HTML extension", () => {
    const value = document("");
    value.editor.update(() => $getRoot().clear().append($createParagraphNode().append($createTextNode("Important").toggleFormat("underline"))), { discrete: true });
    expect(value.export()).toBe("<u>Important</u>");
    expect(document(value.export()).export()).toBe(value.export());
  });
  it("handles nested writing containers without dropping later content", () => {
    const source = ":::callout\nBefore\n\n:::toggle Nested\nInside\n:::\n\nAfter\n:::";
    const output = document(source).export();
    expect(output).toContain("Before"); expect(output).toContain("Inside"); expect(output).toContain("After");
    expect(document(output).export()).toBe(output);
    const { editor } = document(source);
    editor.getEditorState().read(() => {
      const callout = $getRoot().getFirstChild();
      expect(callout?.exportJSON().type).toBe("callout");
      expect(editor.getEditorState().toJSON().root.children[0]).toMatchObject({ children: expect.arrayContaining([expect.objectContaining({ type: "toggle" })]) });
    });
  });
});
it("validates links and images without allowing executable or local URLs", () => {
  for (const url of ["https://example.com", "/docs/page", "#section", "mailto:hello@example.com", "tel:+15555555555"]) expect(safeEditorUrl(url)).toBe(true);
  for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///C:/test", "//example.com", "java\nscript:test", ""]) expect(safeEditorUrl(url)).toBe(false);
  expect(safeEditorUrl("mailto:hello@example.com", true)).toBe(false);
  expect(safeEditorUrl("data:image/svg+xml,test", true)).toBe(false);
});
