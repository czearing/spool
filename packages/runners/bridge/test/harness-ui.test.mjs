import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { assignableAgent, projectsForSnapshot, conversationMessages } from "../../monitor/src/harness/model.mjs";
import { adaptHarness } from "../../monitor/scripts/adapt-harness.mjs";

test("Harness projection keeps native identities, scopes repositories, and does not invent delegation", () => {
  const tasks = [
    { id: "one", agent: "reviewer", title: "First", status: "in_progress", workspace: "C:\\Repo", updatedAt: "2026-09-24T00:00:00Z" },
    { id: "two", agent: "reviewer", title: "Unrelated", status: "completed", workspace: "C:\\Elsewhere", updatedAt: "2026-09-23T00:00:00Z" },
  ];
  const [repo] = projectsForSnapshot({
    checkedAt: "2026-09-24T00:00:00Z", tasks,
    agents: [{ name: "reviewer", state: "Running", currentTaskId: "one" }],
  });
  assert.equal(repo.id, "bohemia");
  assert.equal(repo.name, "Bohemia");
  assert.deepEqual(repo.workItems.map(item => item.id), ["one", "two"]);
  assert.equal(repo.agents[0].status, "working");
  assert.equal(repo.agents[0].statusLabel, "Running");
  assert.equal(repo.agents[0].isLeader, undefined);
  assert.equal(repo.workItems[0].canonicalStatus, "running");
  assert.deepEqual(repo.delegatedActions, []);
});

test("native pause, drain and missing-process observations are not disguised as idle or assignable", () => {
  for (const state of ["Paused", "Draining"]) assert.equal(assignableAgent({ state }), false);
  assert.equal(assignableAgent({ state: "Running" }), true);
  for (const state of ["No process observed", "Waiting for message", "Queued"]) {
    const [project] = projectsForSnapshot({
      agents: [{ name: "one", state, currentTaskId: "task" }],
      tasks: [{ id: "task", agent: "one", title: "Task", status: "in_progress" }],
    });
    assert.equal(project.agents[0].statusLabel, state);
  }
});

test("conversation projection isolates a task, pairs tool results, and holds stable live message keys", () => {
  const task = { id: "one", agent: "reviewer" };
  const entries = [
    { kind: "user", ts: "2026-09-24T00:00:00Z", text: "Original task" },
    { kind: "tool_call", ts: "2026-09-24T00:00:01Z", toolUseId: "call", name: "Inspect", input: "args" },
    { kind: "assistant", ts: "2026-09-24T00:00:02Z", text: "Streaming" },
  ];
  const messages = conversationMessages({ task, entries });
  assert.ok(messages.every(message => message.id.startsWith("one:")));
  assert.equal(messages[1].status, "working");
  const completed = conversationMessages({ task, entries: [...entries.slice(0, -1),
    { ...entries[2], text: "Streaming continued" },
    { kind: "tool_result", toolUseId: "call", isError: true, content: "Failed check" },
  ] });
  assert.equal(completed.length, 3);
  assert.equal(completed[1].status, "failed");
  assert.equal(completed[1].body, "args\n\nFailed check");
  assert.equal(completed[2].id, messages[2].id);
});

test("checked source adaptations retain actual components and remove unsupported engine controls", () => {
  for (const [file, absent] of [
    ["ProjectSidebar/ProjectSidebar.tsx", /name="Harness"|<strong>Harness|label="New project"/],
    ["ProjectView/ProjectView.tsx", /<AgentSectionActions|No project leader\./],
    ["ProjectContextMenu/ProjectContextMenu.tsx", /<span>Project workflow<\/span>|<span>\{pauseLabel\}<\/span>/],
  ]) {
    const original = readFileSync(new URL(`../../monitor/vendor/harness/src/components/${file}`, import.meta.url), "utf8");
    const result = adaptHarness(original, `components/${file}`);
    assert.doesNotMatch(result, absent);
    assert.match(result, /styles\./);
  }
  const file = "components/AgentCard/AgentCardSurface.tsx";
  const surface = readFileSync(new URL(`../../monitor/vendor/harness/src/${file}`, import.meta.url), "utf8");
  for (const source of [surface.replace(/\r\n/g, "\n"), surface.replace(/\r?\n/g, "\r\n")]) {
    assert.match(adaptHarness(source, file), /<StatusIndicator label=\{statusLabel\}/);
  }
});
