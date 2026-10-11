/**
 * Telling a pipeline from a person, and clearing the threads that only a pipeline left behind.
 *
 * Every shape asserted here was taken from live office-bohemia pull requests. The one that matters
 * most is `office-fluid`: a machine identity that is structurally identical to a human, which is
 * why shape alone is not trusted and behaviour has to carry the rest.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { autoCloseTargets, closeAutomatedThreads } from "../lib/auto-close.mjs";
import { classifyAuthor, classifyThreads, learnedMachines, observeIdentities } from "../lib/authorship.mjs";

const human = {
  commentType: "text",
  content: "rename this",
  author: { id: "h1", displayName: "Christian Gonzalez", uniqueName: "chgonz@microsoft.com", descriptor: "aad.abc" },
};

const servicePrincipal = {
  commentType: "text",
  content: "policy check failed",
  author: { id: "sp1", displayName: "GitOps", uniqueName: "", descriptor: "s2s.zzz" },
};

const agencyReview = {
  commentType: "text",
  content: "**Blocking** unsafe innerHTML",
  author: { id: "a1", displayName: "Agency", uniqueName: "", descriptor: "s2s.zzz" },
};

const systemRow = {
  commentType: "system",
  content: "Christian Gonzalez voted 10",
  author: { id: "h1", displayName: "Christian Gonzalez", uniqueName: "chgonz@microsoft.com", descriptor: "aad.abc" },
};

/** The hard case: a real address, a normal descriptor, a text comment. Nothing structural to catch. */
const lookalike = {
  commentType: "text",
  content: "Bundle size grew by 3kb",
  author: { id: "f1", displayName: "office-fluid", uniqueName: "office-fluid@microsoft.com", descriptor: "aad.fff" },
};

const group = {
  commentType: "text",
  content: "policy",
  author: { id: "g1", displayName: "Reviewers", uniqueName: "reviewers", descriptor: "vssgp.ggg", isContainer: true },
};

test("a service principal is machine by shape alone", () => {
  const verdict = classifyAuthor(servicePrincipal, {});
  assert.equal(verdict.kind, "machine");
  assert.equal(verdict.confidence, "shape");
});

test("Agency review feedback is classified as human review", () => {
  const verdict = classifyAuthor(agencyReview, {});
  assert.equal(verdict.kind, "human");
  assert.equal(verdict.confidence, "agency");
});

test("a system row is machine even though it carries a real person's name", () => {
  assert.equal(classifyAuthor(systemRow, {}).kind, "machine");
});

test("a group identity is never a person", () => {
  assert.equal(classifyAuthor(group, {}).kind, "machine");
});

test("a reviewer's own comment is human", () => {
  assert.equal(classifyAuthor(human, {}).kind, "human");
});

test("an unrecognised author is treated as human rather than guessed at", () => {
  const verdict = classifyAuthor(lookalike, {});
  assert.equal(verdict.kind, "human", "no evidence means no closing somebody's thread");
});

test("a look-alike bot is caught by behaviour once it appears on several pull requests", () => {
  const prs = [
    { id: "1", reviewers: [{ id: "h1", uniqueName: "chgonz@microsoft.com" }] },
    { id: "2", reviewers: [{ id: "h1", uniqueName: "chgonz@microsoft.com" }] },
    { id: "3", reviewers: [] },
  ];
  const threadsByPr = {
    1: [{ status: "active", comments: [lookalike, human] }],
    2: [{ status: "active", comments: [lookalike] }],
    3: [{ status: "active", comments: [lookalike] }],
  };

  const machines = learnedMachines(observeIdentities(prs, threadsByPr));
  const verdict = classifyAuthor(lookalike, { machines });

  assert.equal(verdict.kind, "machine");
  assert.equal(verdict.confidence, "behaviour");
  assert.ok(verdict.reason.includes("without ever being a reviewer"));
  // The person commented just as widely, and is not swept up, because they were asked to review.
  assert.equal(classifyAuthor(human, { machines }).kind, "human");
});

test("a person who comments on one pull request is never learned as a machine", () => {
  const prs = [{ id: "1", reviewers: [] }];
  const machines = learnedMachines(observeIdentities(prs, { 1: [{ status: "active", comments: [human] }] }));
  assert.equal(machines.size, 0, "one sighting is not evidence of anything");
});

test("a thread with any human comment in it is a human thread", () => {
  const threads = [{ id: 1, status: "active", comments: [servicePrincipal, human] }];
  const { human: people, automated } = classifyThreads(threads, {});
  assert.equal(people.length, 1);
  assert.equal(automated.length, 0, "a bot replying to a person does not make the thread the bot's");
});

test("resolved threads are counted as nobody's problem", () => {
  const threads = [{ id: 1, status: "fixed", comments: [human] }, { id: 2, status: "closed", comments: [human] }];
  assert.equal(classifyThreads(threads, {}).unresolved, 0);
});

test("a timeline event with no status is not an unresolved comment", () => {
  // Taken verbatim from PR 5626012, where 13 of these were counted as outstanding and would have
  // been written to. Azure DevOps returns them from the same endpoint as review comments.
  const threads = [
    { id: 71595047, comments: [{ commentType: "system", content: "The reference was updated.", author: { id: "00000002-0000-8888-8000-000000000000", displayName: "Microsoft.VisualStudio.Services.TFS", descriptor: "s2s.x" } }] },
    { id: 71813150, comments: [{ commentType: "system", content: "Nate Tan voted 10", author: { id: "n1", displayName: "Nate Tan", uniqueName: "natan@microsoft.com", descriptor: "aad.n" } }] },
  ];
  const counts = classifyThreads(threads, {});
  assert.equal(counts.unresolved, 0, "events are not questions");
  assert.equal(counts.automated.length, 0, "and so there is nothing to close");
});

test("a system row inside an open discussion does not make it closable on its own", () => {
  const threads = [{
    id: 1,
    status: "active",
    comments: [{ commentType: "system", content: "policy updated", author: { id: "t", displayName: "TFS", descriptor: "s2s.x" } }],
  }];
  assert.equal(classifyThreads(threads, {}).unresolved, 0);
});

test("nothing is closed until the approvals are in", () => {
  const threads = [{ id: 1, status: "active", comments: [servicePrincipal] }];
  const decision = autoCloseTargets({ pr: { id: "1" }, threads, approvals: 1 });
  assert.equal(decision.close.length, 0);
  assert.equal(decision.reason, "1 of 2 approvals");
});

test("nothing is closed while a person is still waiting", () => {
  const threads = [
    { id: 1, status: "active", comments: [servicePrincipal] },
    { id: 2, status: "active", comments: [human] },
  ];
  const decision = autoCloseTargets({ pr: { id: "1" }, threads, approvals: 2 });
  assert.equal(decision.close.length, 0);
  assert.equal(decision.reason, "1 unresolved human thread(s)");
});

test("automated threads are closed once two approvals are in and every person is answered", async () => {
  const threads = [
    { id: 11, status: "active", comments: [servicePrincipal] },
    { id: 12, status: "active", comments: [lookalike] },
    { id: 13, status: "fixed", comments: [human] },
  ];
  const closed = [];
  const events = [];
  const result = await closeAutomatedThreads({
    config: {},
    pr: { id: "5622136" },
    threads,
    approvals: 2,
    // office-fluid is only machine by behaviour, so the learned map has to be supplied for it.
    options: { machines: new Map([["id:f1", "commented on 4 pull requests without ever being a reviewer"]]) },
    ado: { updateThreadStatus: async (cfg, prId, threadId, status) => closed.push({ prId, threadId, status }) },
    log: async (event, payload) => events.push({ event, ...payload }),
  });

  assert.equal(result.closed, 2);
  assert.deepEqual(closed.map((entry) => entry.threadId), [11, 12]);
  assert.deepEqual([...new Set(closed.map((entry) => entry.status))], ["closed"]);
  // Every closure has to be able to say what convinced it, since this runs unattended.
  assert.equal(events.filter((entry) => entry.event === "thread_closed").length, 2);
  assert.ok(events[0].why.length > 0);
});

test("a failure to close one thread does not abandon the rest", async () => {
  const threads = [
    { id: 11, status: "active", comments: [servicePrincipal] },
    { id: 12, status: "active", comments: [{ ...servicePrincipal, author: { ...servicePrincipal.author, id: "a2" } }] },
  ];
  const events = [];
  const result = await closeAutomatedThreads({
    config: {},
    pr: { id: "1" },
    threads,
    approvals: 2,
    ado: {
      updateThreadStatus: async (cfg, prId, threadId) => {
        if (threadId === 11) throw new Error("Azure DevOps 403");
        return true;
      },
    },
    log: async (event, payload) => events.push({ event, ...payload }),
  });

  assert.equal(result.closed, 1);
  assert.equal(events.filter((entry) => entry.event === "thread_close_failed").length, 1);
});
