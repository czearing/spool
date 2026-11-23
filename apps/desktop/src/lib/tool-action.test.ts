import { expect, it } from "vitest";
import { toolAction } from "./tool-action";

it("shows the recorded PowerShell purpose rather than its generic executor title or raw command", () => {
  expect(toolAction("powershell", { toolTitle: "Running command",
    arguments: { description: "Run targeted package tests", command: "PRIVATE SHELL INPUT" } })).toBe("Run targeted package tests");
  expect(toolAction("powershell", { toolTitle: "Running command", arguments: { command: "PRIVATE" } })).toBe("Description not recorded");
});
it("identifies file reads and searches from narrowly selected metadata without content", () => {
  expect(toolAction("view", { toolTitle: "Viewing file", arguments: { path: "C:\\Code\\project\\src\\chart.ts", contents: "PRIVATE" } }))
    .toBe("Read project\\src\\chart.ts");
  expect(toolAction("glob", { arguments: { pattern: "**/*.tsx" } })).toBe("Find files matching **/*.tsx");
  expect(toolAction("rg", { arguments: { glob: "*.ts", pattern: "PRIVATE SEARCH" } })).toBe("Search file contents in *.ts");
  expect(toolAction("bohemia-pr-bohemia_pr", { arguments: { action: "create" } })).toBe("create");
});
it("uses recorded titles when needed and bounds text without inventing an activity", () => {
  expect(toolAction("other", { toolTitle: "Inspect build results" })).toBe("Inspect build results");
  expect(toolAction("other", { toolTitle: "other" })).toBe("Description not recorded");
  expect(toolAction("powershell", { arguments: { description: "x".repeat(2000) } })).toHaveLength(500);
});
