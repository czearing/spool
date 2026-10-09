import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PromptSaveError, PromptSync } from "./prompt-sync";
import type { AgentPrompt } from "./agents";

const initial = { id: "engineer", prompt: "Original", revision: "v1" };
function setup() {
  let text = initial.prompt, version = 1;
  const save = vi.fn(async ({ prompt }: { prompt: string; revision: string }): Promise<AgentPrompt> =>
    ({ ...initial, prompt, revision: `v${++version}` }));
  const sync = new PromptSync(initial, save);
  const replace = vi.fn((value: string) => { text = value; });
  sync.connect(() => text, replace);
  return { sync, save, replace, text: () => text, edit: (value: string) => { text = value; sync.changed(() => value); } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it("does not write on mount or normalization-only changes", async () => {
  const { sync, edit, save } = setup();
  edit("Original\r\n"); await vi.advanceTimersByTimeAsync(1000);
  expect(save).not.toHaveBeenCalled(); expect(sync.snapshot().dirty).toBe(false);
});
it("debounces bursts and writes the latest prompt after exactly 500ms", async () => {
  const { sync, edit, save } = setup();
  edit("O"); await vi.advanceTimersByTimeAsync(300); edit("Only newest");
  await vi.advanceTimersByTimeAsync(499); expect(save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(save).toHaveBeenCalledExactlyOnceWith({ prompt: "Only newest", revision: "v1" });
  expect(sync.snapshot().phase).toBe("saved");
});
it("never overlaps writes or marks text typed during an in-flight write as saved", async () => {
  const { sync, edit, save } = setup();
  let complete!: (document: AgentPrompt) => void;
  save.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  edit("First"); const flushing = sync.flush(); edit("Newest");
  await vi.advanceTimersByTimeAsync(500);
  expect(save).toHaveBeenCalledTimes(1); expect(sync.snapshot().dirty).toBe(true);
  complete({ ...initial, prompt: "First", revision: "v2" }); await flushing;
  expect(save).toHaveBeenNthCalledWith(2, { prompt: "Newest", revision: "v2" });
  expect(sync.snapshot().dirty).toBe(false);
});
it("flushes the last keystroke immediately before navigation or unmount", async () => {
  const { sync, edit, save } = setup();
  edit("Last character!"); sync.disconnect(); await sync.flush();
  expect(save).toHaveBeenCalledExactlyOnceWith({ prompt: "Last character!", revision: "v1" });
});
it("preserves drafts after network errors and retries with the same revision", async () => {
  const { sync, edit, save } = setup();
  save.mockRejectedValueOnce(new Error("Network unavailable"));
  edit("Important"); expect(await sync.flush()).toBe(false);
  expect(sync.snapshot()).toMatchObject({ dirty: true, phase: "error", error: "Network unavailable" });
  edit("Most recent"); await vi.advanceTimersByTimeAsync(2000); expect(save).toHaveBeenCalledTimes(1);
  expect(await sync.retry()).toBe(true);
  expect(save).toHaveBeenLastCalledWith({ prompt: "Most recent", revision: "v1" });
});
it("does not retry conflicts automatically or overwrite a newer on-disk revision", async () => {
  const { sync, edit, save } = setup();
  save.mockRejectedValue(new PromptSaveError("Changed elsewhere", 409));
  edit("Draft"); await sync.flush();
  expect(sync.snapshot()).toMatchObject({ dirty: true, conflict: true });
  await vi.advanceTimersByTimeAsync(10_000); expect(save).toHaveBeenCalledTimes(1);
});
it("accepts remote changes only while pristine and not from an obsolete read", async () => {
  const { sync, edit, replace } = setup();
  sync.observe({ ...initial, prompt: "Remote", revision: "v2" }, 0);
  expect(replace).toHaveBeenCalledWith("Remote");
  edit("Local"); await sync.flush();
  sync.observe({ ...initial, prompt: "Old GET", revision: "v1" }, 0);
  expect(replace).toHaveBeenCalledTimes(1);
});
it("keeps local edits intact when polling detects a conflicting external update", () => {
  const { sync, edit, replace, text } = setup();
  edit("Local draft");
  sync.observe({ ...initial, prompt: "External draft", revision: "v2" }, 0);
  expect(text()).toBe("Local draft"); expect(replace).not.toHaveBeenCalled();
  expect(sync.snapshot().conflict).toBe(true);
  sync.accept({ ...initial, prompt: "External draft", revision: "v2" });
  expect(text()).toBe("External draft"); expect(sync.snapshot().dirty).toBe(false);
});
it("reconciles a write that reached disk even if its response was lost", async () => {
  const { sync, edit, save } = setup();
  save.mockRejectedValueOnce(new Error("Connection lost after write"));
  edit("Already saved"); await sync.flush();
  sync.observe({ ...initial, prompt: "Already saved", revision: "v2" }, 0);
  expect(sync.snapshot()).toMatchObject({ dirty: false, error: "", phase: "saved" });
});
it("allows a deliberately cleared prompt to autosave", async () => {
  const { sync, edit, save } = setup();
  edit(""); await sync.flush();
  expect(save).toHaveBeenCalledWith({ prompt: "", revision: "v1" });
});
