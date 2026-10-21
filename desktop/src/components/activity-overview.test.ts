import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentOverview } from "./agent-overview";
import { RunnerOverview } from "./runner-overview";

it("preserves the agent conversation layout, status and actions through the shared overview", () => {
  const html = renderToStaticMarkup(createElement(AgentOverview, { project: "fixture", agent: "engineer",
    jobs: { current: [{ id: "task-1", key: "task:1", title: "Fix tests", status: "in_progress",
      archived: false, updatedAt: "2026-10-21T19:20:00Z" }], history: [] },
    selected: "task-1", onSelect: () => {}, actions: "Agent actions", children: "Conversation content" }));
  expect(html).toContain('aria-label="Conversations"');
  expect(html).toContain("Search conversations");
  expect(html).toContain("New chat");
  expect(html).toContain("Fix tests");
  expect(html).toContain("In progress");
  expect(html).toContain("Agent actions");
  expect(html).toContain("Conversation content");
});
it("uses the same secondary sidebar with run status and a read-only terminal", () => {
  const html = renderToStaticMarkup(createElement(RunnerOverview, { name: "livesite", selected: null,
    onSelect: () => {}, href: () => "#live", logs: { runs: [], output: "<script>actual log text</script>", truncated: false } }));
  expect(html).toContain('aria-label="Runs"');
  expect(html).toContain("Search runs");
  expect(html).toContain("Live");
  expect(html).toContain("Unknown");
  expect(html).toContain("&lt;script&gt;actual log text&lt;/script&gt;");
  expect(html).not.toMatch(/New chat|Add runner|Save|Parameters|<textarea|contenteditable/);
});
