import test from "node:test";
import assert from "node:assert/strict";
import { extractComments, extractTargetIdentifier } from "../parser.js";

test("extracts inline comments and ignores string literals containing slashes", () => {
  const code = `
const url = "https://example.com//not-a-comment";
// This is a real comment
const id = 123;
`;
  const comments = extractComments(code);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].cleanText, "This is a real comment");
  assert.equal(comments[0].targetIdentifier, "id");
});

test("groups consecutive inline comments into a single block", () => {
  const code = `
// First line of essay
// Second line of essay
// Third line of essay
export function doSomething() {}
`;
  const comments = extractComments(code);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].lineCount, 3);
  assert.equal(comments[0].cleanText, "First line of essay\nSecond line of essay\nThird line of essay");
  assert.equal(comments[0].targetIdentifier, "doSomething");
});

test("extracts block and jsdoc comments", () => {
  const code = `
/**
 * JSDoc comment for user
 * @param name The name
 */
export const user = { name: "test" };

/* Standard block comment */
let active = true;
`;
  const comments = extractComments(code);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].commentType, "jsdoc");
  assert.equal(comments[0].targetIdentifier, "user");
  assert.equal(comments[1].commentType, "block");
  assert.equal(comments[1].targetIdentifier, "active");
});

test("extracts various target identifiers accurately", () => {
  assert.equal(extractTargetIdentifier("export async function fetchUserData(id: string) {"), "fetchUserData");
  assert.equal(extractTargetIdentifier("const handleButtonClick = (e) => {"), "handleButtonClick");
  assert.equal(extractTargetIdentifier("interface UserProfileConfig {"), "UserProfileConfig");
  assert.equal(extractTargetIdentifier("public async processQueue() {"), "processQueue");
  assert.equal(extractTargetIdentifier("firstName?: string;"), "firstName");
  assert.equal(extractTargetIdentifier("if (isValid) {"), null);
});
