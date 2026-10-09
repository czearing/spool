import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listAgents, readAgentPrompt, saveAgentPrompt } from "./agents";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const actual = await vi.importActual<typeof fs>("node:fs/promises");
let root: string;
const file = (name = "engineer") => join(root, "agents", `${name}.md`);
const header = "---\r\nmodel: untouched-model\r\ndescription: \"Agent: engineer\"\r\ntools: read, write\r\n---\r\n\r\n";
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "spool-agent-ui-"));
  await fs.mkdir(join(root, "agents"));
  await fs.writeFile(file(), header + "# Instructions\r\n\r\nKeep this safe.\r\n");
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it("lists configured markdown files without reading any prompts or the historical manifest", async () => {
  await fs.writeFile(file("reviewer"), "Review");
  await fs.writeFile(join(root, "agents", "paperclip-prompts.json"), "{broken");
  await fs.writeFile(join(root, "agents", "engineer.md.temp"), "Temporary");
  await fs.mkdir(file("directory"));
  expect(await listAgents(root)).toEqual(["engineer", "reviewer"]);
  expect(fs.readFile).not.toHaveBeenCalled();
  await expect(readAgentPrompt(root, "reviewer")).resolves.toMatchObject({ id: "reviewer", prompt: "Review" });
});
it("treats an absent agents folder as an empty configuration, not a fake agent", async () => {
  expect(await listAgents(join(root, "unconfigured"))).toEqual([]);
});
it("separates frontmatter and returns a revision without exposing file paths or configuration", async () => {
  const document = await readAgentPrompt(root, "engineer");
  expect(document).toEqual({ id: "engineer", prompt: "# Instructions\r\n\r\nKeep this safe.", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.stringify(document)).not.toMatch(/untouched-model|tools:|description:/);
});
it("preserves frontmatter bytes and CRLF line endings when saving only the prompt", async () => {
  const before = await readAgentPrompt(root, "engineer");
  const saved = await saveAgentPrompt(root, "engineer", { prompt: "## Updated\n\n- Keep tests\n- Explain changes", revision: before.revision });
  expect(await actual.readFile(file(), "utf8")).toBe(header + "## Updated\r\n\r\n- Keep tests\r\n- Explain changes\r\n");
  expect(saved.revision).not.toBe(before.revision);
  expect(await readAgentPrompt(root, "engineer")).toEqual(saved);
  expect(await fs.readdir(join(root, "agents"))).toEqual(["engineer.md"]);
});
it("does not rewrite an unchanged prompt's original file bytes", async () => {
  const original = await actual.readFile(file(), "utf8"), document = await readAgentPrompt(root, "engineer");
  await saveAgentPrompt(root, "engineer", document);
  expect(await actual.readFile(file(), "utf8")).toBe(original);
});
it("supports headerless prompts and preserves their final newline convention", async () => {
  await fs.writeFile(file("plain"), "Original instructions");
  const document = await readAgentPrompt(root, "plain");
  await saveAgentPrompt(root, "plain", { ...document, prompt: "# New\n\nInstructions" });
  expect(await actual.readFile(file("plain"), "utf8")).toBe("# New\n\nInstructions");
});
it("rejects stale saves even when only the configuration changed", async () => {
  const document = await readAgentPrompt(root, "engineer");
  const changed = header.replace("untouched-model", "externally-updated") + "Latest instructions\n";
  await fs.writeFile(file(), changed);
  await expect(saveAgentPrompt(root, "engineer", { ...document, prompt: "Stale edit" })).rejects.toMatchObject({ status: 409 });
  expect(await actual.readFile(file(), "utf8")).toBe(changed);
  expect(await fs.readdir(join(root, "agents"))).toEqual(["engineer.md"]);
});
it("prevents concurrent writes from losing another editor's changes", async () => {
  const document = await readAgentPrompt(root, "engineer");
  const results = await Promise.allSettled(["First", "Second"].map((prompt) => saveAgentPrompt(root, "engineer", { ...document, prompt })));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const failed = results.find((result) => result.status === "rejected");
  expect(failed?.status === "rejected" && failed.reason.status).toBe(409);
  expect(await fs.readdir(join(root, "agents"))).toEqual(["engineer.md"]);
});
it("does not remove someone else's save lock", async () => {
  const document = await readAgentPrompt(root, "engineer");
  await fs.writeFile(`${file()}.lock`, "Other writer");
  await expect(saveAgentPrompt(root, "engineer", { ...document, prompt: "No" })).rejects.toMatchObject({ status: 409 });
  expect(await actual.readFile(`${file()}.lock`, "utf8")).toBe("Other writer");
});
it.each(["../engineer", "..\\engineer", "engineer.md", "C:\\outside", ""])("rejects unconfigured path %s", async (id) => {
  await expect(readAgentPrompt(root, id)).rejects.toMatchObject({ status: 404 });
});
it("refuses to create new agents through the prompt endpoint", async () => {
  await expect(saveAgentPrompt(root, "missing", { revision: "a".repeat(64), prompt: "Create?" })).rejects.toMatchObject({ status: 404 });
  expect(await fs.readdir(join(root, "agents"))).toEqual(["engineer.md"]);
});
it.each(["\0", "x".repeat(120_001)])("rejects invalid prompt input without changing the file (%#. case)", async (prompt) => {
  const document = await readAgentPrompt(root, "engineer");
  await expect(saveAgentPrompt(root, "engineer", { ...document, prompt })).rejects.toMatchObject({ status: 400 });
  expect(await readAgentPrompt(root, "engineer")).toEqual(document);
});
it("persists a deliberately cleared prompt without removing its configuration", async () => {
  const document = await readAgentPrompt(root, "engineer");
  const saved = await saveAgentPrompt(root, "engineer", { ...document, prompt: "" });
  expect(saved.prompt).toBe("");
  expect(await actual.readFile(file(), "utf8")).toBe(header + "\r\n");
});
it("rejects invalid UTF-8 rather than replacing bytes on save", async () => {
  await fs.writeFile(file("broken"), Buffer.from([0xff, 0xfe, 0x00]));
  await expect(readAgentPrompt(root, "broken")).rejects.toMatchObject({ status: 400 });
});
it("rejects an agents directory junction pointing outside the configured project", async () => {
  const other = join(root, "other"); await fs.mkdir(other);
  await fs.symlink(join(root, "agents"), join(other, "agents"), "junction");
  await expect(readAgentPrompt(other, "engineer")).rejects.toMatchObject({ status: 400 });
  await expect(listAgents(other)).rejects.toMatchObject({ status: 400 });
});
