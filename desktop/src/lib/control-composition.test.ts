import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const read = (file: string) => readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");

it("keeps board fields and toolbar controls on their shared primitives", () => {
  for (const file of ["board-toolbar.tsx", "board-composer.tsx"]) {
    expect(read(file)).toContain("<Input ");
    expect(read(file)).not.toMatch(/<input\b|<label\b/);
  }
  expect(read("board-toolbar.tsx")).toContain("<Toolbar ");
  expect(read("board-toolbar.tsx")).toContain("<Divider");
  expect(read("archive-section.tsx")).toContain("<Divider");
  for (const file of ["archive.tsx", "archived-tasks.tsx"]) expect(read(file)).toContain("<ArchiveSection");
  expect(read("board-controls.module.css")).not.toMatch(/\.search input|\.composer input|border-bottom:/);
});
it("shares insertion presentation without replacing board, list or editor drag engines", () => {
  for (const file of ["board-item.tsx", "ui/list-header.tsx", "ui/editor/block-drag.tsx"]) expect(read(file)).toContain("<DropIndicator");
  expect(read("board.module.css")).not.toContain('data-insertion="true"]::before');
  expect(read("ui/list.module.css")).not.toContain(".columnDrop");
});
it("keeps writing-specific adapters separate from shared surfaces", () => {
  expect(read("ui/editor/selection-toolbar.tsx")).toContain('from "../popover"');
  expect(read("ui/editor/slash-menu.tsx")).toContain('from "../command-list"');
  const nodes = read("ui/editor/container-nodes.ts");
  expect(nodes).toContain("createCalloutDOM(document)");
  expect(nodes).toContain("createCollapsibleDOM(document");
  expect(nodes).not.toMatch(/createElement\("(?:aside|details|summary)"\)/);
  for (const file of ["popover", "command-list", "callout", "collapsible", "drop-indicator"]) {
    expect(read(`ui/${file}.tsx`)).not.toMatch(/from ["'](?:lexical|@lexical\/)/);
  }
});
it("shares file picker input and button controls with project configuration", () => {
  expect(read("create-project-dialog.tsx")).toContain("<FilePicker");
  expect(read("ui/file-picker.tsx")).toContain("<Input");
  expect(read("ui/file-picker.tsx")).toContain("<Button");
  expect(read("ui/file-picker.tsx")).not.toMatch(/<input\b|<button\b/);
});
it("composes agents from the existing sidebar, accordion and editor", () => {
  expect(read("app-shell.tsx")).toContain("<SidebarAccordion");
  expect(read("ui/sidebar.tsx")).toContain("<Accordion");
  expect(read("agent-prompt-editor.tsx")).toContain('import("./ui/editor")');
  expect(read("agent-prompt-editor.tsx")).not.toMatch(/<textarea\b|contentEditable=/);
});
