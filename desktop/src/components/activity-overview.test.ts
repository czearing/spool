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
it("keeps archived conversations in a collapsed archive instead of the main list", () => {
  const html = renderToStaticMarkup(createElement(AgentOverview, { project: "fixture", agent: "engineer",
    jobs: { current: [{ id: "active", key: "task:active", title: "Current conversation", status: "in_progress",
      archived: false, updatedAt: null }], history: [{ id: "old", key: "task:old", title: "Old conversation",
      status: "completed", archived: true, updatedAt: null }] },
    selected: null, onSelect: () => {}, actions: null, children: null }));
  expect(html).toContain("Current conversation");
  expect(html).toContain("Archive");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("Old conversation");
});
it("opens the archive for a selected archived conversation and preserves its link", () => {
  const html = renderToStaticMarkup(createElement(AgentOverview, { project: "fixture", agent: "engineer",
    jobs: { current: [], history: [{ id: "old", key: "task:old", title: "Old conversation",
      status: "completed", archived: true, updatedAt: null }] },
    selected: "old", onSelect: () => {}, actions: null, children: null }));
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('href="/fixture/agents/engineer?task=old"');
  expect(html).toContain('aria-current="page"');
  expect(html).not.toContain("No conversations yet.");
});
