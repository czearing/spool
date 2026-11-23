import { beforeEach, expect, it, vi } from "vitest";
import { GET, POST } from "../app/api/projects/[project]/tasks/[task]/conversation/route";
import { readConversation, sendTaskMessage } from "./spool-conversation";
import { readConversationTask } from "./conversation-store";
import { getProjects } from "./projects";
import { ConversationError, type TaskConversation } from "./task-conversation";

vi.mock("./projects", () => ({ getProjects: vi.fn() }));
vi.mock("./spool-conversation", () => ({ readConversation: vi.fn(), sendTaskMessage: vi.fn() }));
vi.mock("./conversation-store", () => ({ readConversationTask: vi.fn() }));
const read = vi.mocked(readConversation);
const context = { params: Promise.resolve({ project: "fixture", task: "one" }) };
const snapshot = {
  task: { id: "one", agent: "engineer", title: "Conversation", prompt: "Original work", status: "in_progress" },
  entries: [{ id: "log:0", offset: 0, kind: "assistant", ts: "2026-11-04T20:00:00Z", text: "Saved reply" }],
  raw: true, logId: "original", cursor: 100, nextBefore: null, limited: false,
  available: true, canSend: true, readOnlyReason: "", activity: "working",
} satisfies TaskConversation;
const request = (etag?: string) => GET(new Request("http://localhost/api/projects/fixture/tasks/one/conversation?events=1",
  { headers: etag ? { "If-None-Match": etag } : {} }), context);
beforeEach(() => {
  read.mockReset(); read.mockResolvedValue(snapshot);
  vi.mocked(getProjects).mockReset().mockResolvedValue([{ id: "fixture", name: "Fixture", root: "fixture-root" }]);
  vi.mocked(readConversationTask).mockReset().mockReturnValue(snapshot.task);
  vi.mocked(sendTaskMessage).mockReset();
});

it("revalidates an unchanged conversation without returning its history again", async () => {
  const first = await request(), etag = first.headers.get("etag");
  expect(etag).toBeTruthy();
  expect(await first.json()).toEqual(snapshot);
  const unchanged = await request(etag!);
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");
  expect(unchanged.headers.get("cache-control")).toBe("no-store");
  expect(read).toHaveBeenCalledTimes(2);
});
it.each([
  { canSend: false, readOnlyReason: "Messaging is not enabled." },
  { connection: { message: "Reconnecting." } },
  { task: { ...snapshot.task, interaction: { messages: [
    { id: "pending", text: "Follow-up", status: "queued", created_at: "2026-11-04T20:01:00Z" },
  ] } } },
  { entries: [{ ...snapshot.entries[0], text: "Rewritten reply" }] },
  { logId: "rotated" },
])("returns a fresh snapshot when content or access changes: %j", async change => {
  const etag = (await request()).headers.get("etag")!;
  read.mockResolvedValue({ ...snapshot, ...change });
  const fresh = await request(etag);
  expect(fresh.status).toBe(200);
  expect(fresh.headers.get("etag")).not.toBe(etag);
  expect(await fresh.json()).toEqual({ ...snapshot, ...change });
});
it("does not hide deletion behind a previously valid response", async () => {
  const etag = (await request()).headers.get("etag")!;
  read.mockRejectedValue(new ConversationError("Task not found.", 404));
  expect((await request(etag)).status).toBe(404);
});
it("opens a task moved to another registered project without recreating it", async () => {
  vi.mocked(getProjects).mockResolvedValue([
    { id: "fixture", name: "Old project", root: "fixture-root" },
    { id: "owner", name: "1JS", root: "owner-root" },
  ]);
  vi.mocked(readConversationTask).mockImplementation(root => root === "owner-root" ? snapshot.task : null);
  read.mockImplementation(async root => {
    if (root !== "owner-root") throw new ConversationError("Task not found.", 404);
    return snapshot;
  });
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(snapshot);
  expect(read).toHaveBeenCalledWith("owner-root", "one", null, true);
  vi.mocked(sendTaskMessage).mockResolvedValue({ id: "message", state: "queued" });
  const sent = await POST(new Request("http://localhost/api/projects/fixture/tasks/one/conversation", {
    method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ id: "message", message: "Continue the original conversation" }),
  }), context);
  expect(sent.status).toBe(200);
  expect(sendTaskMessage).toHaveBeenCalledWith("owner-root", "one",
    { id: "message", message: "Continue the original conversation" });
});
it("keeps local ownership and does not search unrelated projects for an existing task", async () => {
  vi.mocked(getProjects).mockResolvedValue([
    { id: "fixture", name: "Fixture", root: "fixture-root" },
    { id: "other", name: "Other", root: "other-root" },
  ]);
  await request();
  expect(vi.mocked(readConversationTask).mock.calls).toEqual([["fixture-root", "one"]]);
  expect(read).toHaveBeenCalledWith("fixture-root", "one", null, true);
});
it.each([0, 2])("does not guess ownership when %s other projects contain the task", async count => {
  vi.mocked(getProjects).mockResolvedValue([
    { id: "fixture", name: "Fixture", root: "fixture-root" },
    ...Array.from({ length: count }, (_, index) => ({ id: `other-${index}`, name: `Other ${index}`, root: `other-${index}` })),
  ]);
  vi.mocked(readConversationTask).mockImplementation(root => root === "fixture-root" ? null : snapshot.task);
  read.mockRejectedValue(new ConversationError("Task not found.", 404));
  expect((await request()).status).toBe(404);
  expect(read).toHaveBeenCalledWith("fixture-root", "one", null, true);
});
