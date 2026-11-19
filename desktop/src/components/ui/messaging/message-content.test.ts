import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { StreamdownProps } from "streamdown";
import { MessageContent } from "./message-content";

const counters = vi.hoisted(() => ({ streamingSplits: 0 }));
vi.mock("streamdown", async original => {
  const actual = await original<typeof import("streamdown")>();
  const { createElement } = await import("react");
  return { ...actual, Streamdown: (props: StreamdownProps) => createElement(actual.Streamdown, {
    ...props, parseMarkdownIntoBlocksFn: props.parseMarkdownIntoBlocksFn ?? (markdown => {
      counters.streamingSplits++;
      return actual.parseMarkdownIntoBlocks(markdown);
    }),
  }) };
});
beforeEach(() => { counters.streamingSplits = 0; });

it("renders a completed Markdown document without parsing streaming blocks first", () => {
  const markdown = "# Verified result\n\nA **complete** reply with `inline code`.\n\n1. First\n2. Second\n\n" +
    "| File | Result |\n| --- | --- |\n| app.ts | Passed |\n\n```ts\nconst done = true;\n```\n\n" +
    "[Details](https://example.test/details)";
  const html = renderToStaticMarkup(createElement(MessageContent, { markdown, reading: true }));
  expect(counters.streamingSplits).toBe(0);
  for (const fragment of ["<h1", "Verified result", "<strong>complete</strong>", "<ol", "<table", "app.ts", "<pre", "const done = true;"])
    expect(html).toContain(fragment);
  expect(html).toContain('href="https://example.test/details"');
});
it("keeps the existing streaming splitter for incomplete replies", () => {
  const html = renderToStaticMarkup(createElement(MessageContent, {
    markdown: "Checking **the result", streaming: true,
  }));
  expect(counters.streamingSplits).toBeGreaterThan(0);
  expect(html).toContain("Checking");
  expect(html).toContain("<strong>the result</strong>");
});
it("preserves safe-link and raw-HTML restrictions for completed messages", () => {
  const html = renderToStaticMarkup(createElement(MessageContent, {
    markdown: '[Unsafe](javascript:alert%281%29)\n\n<script>alert("unsafe")</script>\n\n![Hidden](https://example.test/image.png)',
  }));
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).toContain("[Image: Hidden]");
});
