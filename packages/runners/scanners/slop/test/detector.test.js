import test from "node:test";
import assert from "node:assert/strict";
import { evaluateComment } from "../detector.js";

test("flags tautological echo comments", () => {
  const comment = {
    startLine: 1,
    endLine: 1,
    lineCount: 1,
    commentType: "inline",
    rawText: "// Set the user name",
    cleanText: "Set the user name",
    targetIdentifier: "setUserName",
    targetCodeLine: "function setUserName(name: string) {",
    targetCodeBlock: ["function setUserName(name: string) {"],
  };

  const result = evaluateComment(comment);
  assert.ok(result);
  assert.equal(result.category, "tautology");
  assert.match(result.reasons[0], /Tautological echo/);
  assert.ok(result.score >= 60);
});

test("flags AI filler boilerplate comments", () => {
  const comment = {
    startLine: 1,
    endLine: 2,
    lineCount: 2,
    commentType: "inline",
    rawText: "// This function is responsible for fetching and handling data.\n// Helper function to ensure everything runs smoothly.",
    cleanText: "This function is responsible for fetching and handling data.\nHelper function to ensure everything runs smoothly.",
    targetIdentifier: "fetchData",
    targetCodeLine: "function fetchData() {",
    targetCodeBlock: ["function fetchData() {"],
  };

  const result = evaluateComment(comment);
  assert.ok(result);
  assert.equal(result.category, "ai_filler");
  assert.ok(result.score >= 60);
});

test("flags structural noise section banners", () => {
  const comment = {
    startLine: 1,
    endLine: 1,
    lineCount: 1,
    commentType: "inline",
    rawText: "// ==================== STATE HOOKS ====================",
    cleanText: "==================== STATE HOOKS ====================",
    targetIdentifier: "count",
    targetCodeLine: "const [count, setCount] = useState(0);",
    targetCodeBlock: ["const [count, setCount] = useState(0);"],
  };

  const result = evaluateComment(comment);
  assert.ok(result);
  assert.equal(result.category, "structural_noise");
  assert.equal(result.severity, "high");
});

test("flags micro-narration above obvious control flow", () => {
  const comment = {
    startLine: 1,
    endLine: 1,
    lineCount: 1,
    commentType: "inline",
    rawText: "// If user exists",
    cleanText: "If user exists",
    targetIdentifier: null,
    targetCodeLine: "if (user) {",
    targetCodeBlock: ["if (user) {"],
  };

  const result = evaluateComment(comment);
  assert.ok(result);
  assert.equal(result.category, "micro_narration");
  assert.ok(result.score >= 70);
});

test("flags bloated JSDoc with redundant parameter descriptions", () => {
  const comment = {
    startLine: 1,
    endLine: 5,
    lineCount: 5,
    commentType: "jsdoc",
    rawText: "/**\n * Fetches item\n * @param id The id\n * @param name The name\n * @returns The result\n */",
    cleanText: "Fetches item\n@param id The id\n@param name The name\n@returns The result",
    targetIdentifier: "fetchItem",
    targetCodeLine: "function fetchItem(id: string, name: string) {",
    targetCodeBlock: ["function fetchItem(id: string, name: string) {"],
  };

  const result = evaluateComment(comment);
  assert.ok(result);
  assert.equal(result.category, "bloated_doc");
  assert.ok(result.score >= 60);
});

test("exempts linter directives, copyright, and bug links", () => {
  const eslintComment = {
    rawText: "// eslint-disable-next-line react-hooks/exhaustive-deps",
    cleanText: "eslint-disable-next-line react-hooks/exhaustive-deps",
    lineCount: 1,
  };
  assert.equal(evaluateComment(eslintComment), null);

  const copyrightComment = {
    rawText: "// Copyright (c) Microsoft Corporation. All rights reserved.",
    cleanText: "Copyright (c) Microsoft Corporation. All rights reserved.",
    lineCount: 1,
  };
  assert.equal(evaluateComment(copyrightComment), null);

  const bugComment = {
    rawText: "// Workaround for bug https://github.com/microsoft/issue/123",
    cleanText: "Workaround for bug https://github.com/microsoft/issue/123",
    lineCount: 1,
  };
  assert.equal(evaluateComment(bugComment), null);
});
