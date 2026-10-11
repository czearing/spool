/**
 * A read only projection of the append only log, for a person who wants to see what is open without
 * asking anyone. Nothing in the execution path reads this file, and deleting it changes nothing.
 */

import { rollup } from "../../packages/bohemia-agent-tooling/src/index.js";
import { openTasks } from "./open-tasks.js";

export function buildTodoView(records, { maxOpenTasks, minOverage, ranked = [], scanned = null } = {}) {
  const state = rollup(records);
  const held = openTasks(records);
  const cycles = records.filter((record) => record.kind === "cycle");
  const last = cycles[cycles.length - 1] ?? null;

  const lines = [
    "# docs engine",
    "",
    "Derived from the telemetry log. Read only. Nothing reads this back.",
    "",
    `cycles: ${state.cycles}, empty cycles: ${state.emptyCycles}, issues written: ${state.issuesWritten}`,
    `open tasks: ${held.length} of ${maxOpenTasks}, overage floor: ${minOverage}`,
    last ? `last cycle: ${last.ts}, gate ${last.gate?.reason ?? "none"}, selection ${last.selectionReason}` : "last cycle: none",
    scanned ? `files measured: ${scanned.built.measured.length}, skipped by exclusion: ${scanned.scan.skipped.length}` : null,
    "",
    "## open",
  ];

  if (held.length === 0) lines.push("", "nothing open");
  for (const task of held) {
    lines.push(
      "",
      `- ${task.metric}`,
      `  issue: ${task.issueId}`,
      `  overage at hand over: ${task.current}`,
      `  opened: ${task.openedAt}`,
      task.held ? `  holding its slot: the queue could not be read, ${task.holdReason}` : null,
    );
  }

  lines.push("", "## waiting behind the cap");
  if (ranked.length === 0) lines.push("", "nothing over budget");
  for (const entry of ranked) {
    lines.push("", `- ${entry.set}, overage ${entry.overage}, ${entry.files} file(s), reader ${entry.reader}`);
  }

  lines.push("");
  return lines.filter((line) => line !== null).join("\n");
}
