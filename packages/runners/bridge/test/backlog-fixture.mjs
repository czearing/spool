import path from "node:path";
import { mkdirSync, unlinkSync } from "node:fs";
import { fixture } from "./fixtures.mjs";
import { writeJson } from "../spool-store.mjs";
import { createSpoolQueue } from "../queue.mjs";
import { createBacklogScan } from "../backlog.mjs";

export const reviewers = [
  { name: "Nate Tan", id: "11111111-1111-4111-8111-111111111111" },
  { name: "Torre Taylor", id: "22222222-2222-4222-8222-222222222222" },
  { name: "Justin Fernald", id: "33333333-3333-4333-8333-333333333333" },
];
export const item = (id, extra = {}) => ({ id, rev: 1, type: "Task", title: `Task ${id}`,
  state: "New", project: "OC", parentId: 12284752, assignedTo: "owner@example.test",
  priority: 1, createdAt: "2026-01-01T00:00:00Z", relations: [], ...extra });
export function backlogFixture(t, options = {}) {
  const f = fixture(t), runtime = path.join(f.root, "runtime");
  mkdirSync(runtime);
  const config = { agentId: "software-engineer-2", maxOpenPrs: 3, parentWorkItem: 12284752,
    workItemProject: "OC", baseBranch: "main", legacyBranchPrefixes: ["library-backlog-"], reviewers,
    ado: { organization: "https://dev.azure.com/office", project: "Office", repository: "1JS",
      projectId: "project-id", creatorId: "creator-id", authorAccount: "owner@example.test" }, ...options.config };
  const items = new Map((options.items || [item(2, { priority: 2 }), item(1)]).map(item => [item.id, item]));
  const prs = new Map(), calls = { prepare: [], link: [], reviewers: [], close: [], lists: 0 };
  const repo = { id: "repo-id", project: { id: "project-id" }, defaultBranch: "refs/heads/main" };
  const client = {
    list: async () => [...items.values()].filter(item => !["Closed", "Removed"].includes(item.state)),
    item: async id => structuredClone(items.get(id)),
    isOpen: async item => !["Closed", "Removed", "Cut"].includes(item.state),
    isCompleted: async item => item.state === "Closed",
    activate: async item => {
      const current = items.get(item.id);
      if (current.state === "New") { current.state = "Active"; current.rev++; }
      return structuredClone(current);
    },
    repository: async () => repo, verifyReviewers: async () => {},
    listPullRequests: async (_ado, options) => {
      calls.lists++;
      if (!options.allPages || !options.refresh) throw new Error("Fresh all-page capacity required");
      return [...prs.values()].map(pr => ({ id: String(pr.pullRequestId), status: pr.status,
        branch: pr.sourceRefName.replace(/^refs\/heads\//, ""), isDraft: pr.isDraft }));
    },
    findPr: async branch => [...prs.values()].find(pr => pr.sourceRefName === `refs/heads/${branch}`) || null,
    getPr: async id => structuredClone(prs.get(id)),
    artifact: (_repo, pr) => `vstfs:///Git/PullRequestId/project-id%2Frepo-id%2F${pr.pullRequestId}`,
    link: async (item, url) => {
      calls.link.push({ id: item.id, url });
      const current = items.get(item.id);
      current.relations.push({ rel: "ArtifactLink", url, attributes: { name: "Pull Request" } });
      current.rev++;
      return structuredClone(current);
    },
    reviewers: async pr => { calls.reviewers.push(pr.pullRequestId); return pr; },
    close: async item => {
      calls.close.push(item.id);
      const current = items.get(item.id); current.rev++; current.state = "Closed";
      return structuredClone(current);
    },
    itemUrl: id => `https://office.visualstudio.com/OC/_workitems/edit/${id}`,
    ...options.client,
  };
  const queue = createSpoolQueue(f.store, { agent: config.agentId, workspace: f.workspace,
    runner: "backlog", identity: "library-backlog", verbatimPrompt: true });
  const prepare = async args => {
    calls.prepare.push(args);
    if (args.prepared) return args.prepared;
    return { ...f.preparation, branch: args.branch.startsWith("user/") ? args.branch : `user/calebzearing/${args.branch}` };
  };
  const scan = () => createBacklogScan({ store: f.store, config, queue, workspace: f.workspace, runtime,
    prepare: options.prepare || prepare, client })();
  function finish(id, status = "completed") {
    const task = f.store.task(id);
    unlinkSync(task.file);
    f.put({ ...task, file: undefined, status }, status);
  }
  function publish(id, extra = {}) {
    const task = f.store.task(id);
    const branch = `user/calebzearing/library-backlog-12284752-${f.store.metadata(id).handoff.workItem.id}`;
    const pr = { pullRequestId: prs.size + 1, status: "active", isDraft: false, repository: repo,
      createdBy: { id: config.ado.creatorId }, sourceRefName: `refs/heads/${branch}`,
      targetRefName: "refs/heads/main", mergeStatus: "succeeded",
      lastMergeCommit: { commitId: "b".repeat(40) }, lastMergeSourceCommit: { commitId: "c".repeat(40) },
      reviewers: reviewers.map(reviewer => ({ ...reviewer, vote: 0 })), ...extra };
    prs.set(pr.pullRequestId, pr);
    writeJson(path.join(f.store.records, "native-creators", `${id}.json`), {
      verified: true, originKind: "spool", taskId: id, agent: task.agent, workspace: task.workspace,
      sessionId: task.session_id, branch, prId: String(pr.pullRequestId), prUrl: "https://example.test/pr/1",
    });
    return pr;
  }
  return { ...f, runtime, config, items, prs, calls, client, queue, prepare, scan, finish, publish };
}
