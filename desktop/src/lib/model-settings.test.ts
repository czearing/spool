import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, it, expect } from "vitest";
import { readModelSettings, saveModelSettings } from "./model-settings";
import { readAgentPrompt, saveAgentPrompt } from "./agents";
import { agentModel, replaceAgentModel } from "./agent-model";

let root: string;
const role = () => join(root, "agents", "engineer.md");
const source = "---\r\nmodel: old-model\r\ndescription: Keep me\r\nreasoning: high\r\n---\r\n\r\n# Prompt\r\nOriginal bytes.\r\n";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-model-settings-"));
  await mkdir(join(root, "agents")); await mkdir(join(root, "controls"));
  await writeFile(role(), source);
  await writeFile(join(root, "controls", "capabilities.json"), JSON.stringify({ projectModelVersion: 1, updatedAt: new Date().toISOString() }));
});
afterEach(() => rm(root, { recursive: true, force: true }));
it("persists project configuration and preserves unrelated fields", async () => {
  expect(await readModelSettings(root)).toMatchObject({ model: "gpt-5.4", defaultModel: "gpt-5.4" });
  await writeFile(join(root, "spool.json"), '{"version":1,"defaultModel":"before","other":{"keep":true}}');
  const current = await readModelSettings(root);
  await saveModelSettings(root, undefined, { ...current, model: "after" });
  expect(JSON.parse(await readFile(join(root, "spool.json"), "utf8"))).toEqual({ version: 1, defaultModel: "after", other: { keep: true } });
  expect(await readFile(role(), "utf8")).toBe(source);
  await expect(saveModelSettings(root, undefined, { ...current, model: "stale" })).rejects.toMatchObject({ status: 409 });
});
it("changes only model frontmatter and shares prompt editor conflict protection", async () => {
  const prompt = await readAgentPrompt(root, "engineer"), current = await readModelSettings(root, "engineer");
  await saveModelSettings(root, "engineer", { ...current, model: "new-model" });
  expect(await readFile(role(), "utf8")).toBe(source.replace("model: old-model\r\n", "").replace("---\r\n\r\n# Prompt", "model: new-model\r\n---\r\n\r\n# Prompt"));
  expect((await readAgentPrompt(root, "engineer")).prompt).toBe(prompt.prompt);
  await expect(saveAgentPrompt(root, "engineer", { ...prompt, prompt: "Stale text" })).rejects.toMatchObject({ status: 409 });
  const latest = await readModelSettings(root, "engineer");
  await saveModelSettings(root, "engineer", { ...latest, model: null });
  expect(await readModelSettings(root, "engineer")).toMatchObject({ model: null, defaultModel: "gpt-5.4" });
  expect(await readFile(role(), "utf8")).toBe(source.replace("model: old-model\r\n", ""));
  await saveModelSettings(root, undefined, { ...await readModelSettings(root), model: "project-two" });
  expect(await readModelSettings(root, "engineer")).toMatchObject({ model: null, defaultModel: "project-two" });
  expect(await readdir(join(root, "agents"))).toEqual(["engineer.md"]);
});
it("preserves a headerless prompt and its whitespace when adding or clearing an override", () => {
  const body = "\r\n# Instructions\r\n\r\n";
  const changed = replaceAgentModel(body, "explicit");
  expect(changed).toBe("---\r\nmodel: explicit\r\n---\r\n" + body);
  expect(agentModel(changed)).toBe("explicit");
  expect(replaceAgentModel(body, null)).toBe(body);
});
it("rejects malformed settings, duplicate models, and missing agents", async () => {
  for (const model of [null, "", "--flag", "a b", 12]) {
    await expect(saveModelSettings(root, undefined, { ...await readModelSettings(root), model })).rejects.toMatchObject({ status: 400 });
  }
  expect(() => agentModel("---\nmodel: one\nmodel: two\n---\nBody")).toThrow("duplicate");
  await expect(readModelSettings(root, "../other")).rejects.toMatchObject({ status: 404 });
  await expect(readModelSettings(root, "missing")).rejects.toMatchObject({ status: 404 });
  await writeFile(join(root, "spool.json"), "");
  await expect(readModelSettings(root)).rejects.toThrow();
});
it("requires a fresh capable daemon and does not remove another writer's lock", async () => {
  const current = await readModelSettings(root);
  await writeFile(join(root, "spool.json.lock"), "Other writer");
  await expect(saveModelSettings(root, undefined, { ...current, model: "changed" })).rejects.toMatchObject({ status: 409 });
  expect(await readFile(join(root, "spool.json.lock"), "utf8")).toBe("Other writer");
  await writeFile(join(root, "controls", "capabilities.json"), '{"projectModelVersion":1,"updatedAt":"2000-01-01"}');
  await expect(saveModelSettings(root, undefined, { ...current, model: "changed" })).rejects.toMatchObject({ status: 503 });
});
