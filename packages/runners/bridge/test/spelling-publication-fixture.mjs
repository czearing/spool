import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fixture } from "./fixtures.mjs";
import { writeJson } from "../spool-store.mjs";
import { createSpellingPublisher } from "../../scanners/spelling/publish.mjs";
import { creationContext, createWithOrigin } from "../../packages/bohemia-pr-mcp/src/pr-origin.mjs";
import { scannerVersion } from "../../scanners/spelling/check.mjs";

export const team = "[OC]\\FluidX_Table";
export const rule = (scope, notifyOnly, required = []) => ({ branches: "[Ref] refs/heads/master",
  scope: `[Glob] ${scope}`, required, optional: [], hidden: [], notifyOnly });
export const policy = rules => JSON.stringify({ providers: [{ provider: "Ownership/CodeReviewers",
  allowInheritance: true, metadata: { reviewers: rules } }] });
export const identities = new Map([[team, { group: true }], ["person", { group: false }], ["other", { group: true }]]);
export const issue = (word, column, extra = {}) => ({ word, line: 1, column, kind: "spelling", suggestions: ["misspelled"], ...extra });
export const before = "// A missspelled comment.\nexport const value = 1;\n";
export const finding = file => ({ file, issues: [issue("missspelled", 6)] });

export function publication(t) {
  const f = fixture(t);
  writeFileSync(path.join(f.root, "agents", "spelling.md"), "Fix spelling and grammar in comments and Markdown without changing executable code or interfaces.\n");
  const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8",
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(f.workspace, "init", "-b", "master");
  git(f.workspace, "config", "user.name", "Fixture"); git(f.workspace, "config", "user.email", "fixture@example.invalid");
  mkdirSync(path.join(f.workspace, "packages", "a", "src"), { recursive: true });
  mkdirSync(path.join(f.workspace, ".azuredevops", "policies", "branchpolicies", "master"), { recursive: true });
  writeFileSync(path.join(f.workspace, "packages", "a", "src", "a.ts"), before);
  writeFileSync(path.join(f.workspace, ".azuredevops", "policies", "branchpolicies", "master", "requiredReviewers.yml"),
    policy([rule("/packages/**", [team])]));
  git(f.workspace, "add", "."); git(f.workspace, "commit", "-m", "source");
  const publicationRoot = path.join(f.root, "publication");
  git(f.root, "clone", "--quiet", f.workspace, publicationRoot);
  git(publicationRoot, "config", "user.name", "Fixture"); git(publicationRoot, "config", "user.email", "fixture@example.invalid");
  const report = { scannerVersion, repo: f.workspace, commit: git(f.workspace, "rev-parse", "HEAD"),
    findings: [finding("packages/a/src/a.ts")] };
  const runtime = path.join(f.root, "runtime"), prs = [], calls = [], config = {
    publishAgent: "spelling", publicationRoot, ado: { repository: "fixture" },
  };
  let posts = 0, updates = 0;
  const api = { url: (_repo, id) => `https://example.invalid/OC/_git/fixture/pullrequest/${id}`,
    async list(_repo, branch) { return prs.filter(pr => pr.sourceRefName === `refs/heads/${branch}`); },
    async get(_repo, id) { return prs.find(pr => pr.pullRequestId === id); },
    async create(input) {
      posts++;
      git(publicationRoot, "push", "origin", input.sourceBranch);
      const pr = { pullRequestId: 123, sourceRefName: `refs/heads/${input.sourceBranch}`,
        sourceCommit: git(publicationRoot, "rev-parse", "HEAD"),
        targetRefName: `refs/heads/${input.targetBranch}`, description: input.description, status: "active" };
      prs.push(pr); return pr;
    } };
  const remote = pr => ({ ...pr, id: String(pr.pullRequestId), url: api.url("fixture", pr.pullRequestId),
    branch: pr.sourceRefName.slice(11), targetBranch: pr.targetRefName?.slice(11) });
  const options = { store: f.store, config, runtime, support() {}, identities: async () => identities,
    list: async () => prs.filter(pr => pr.status === "active").map(remote),
    get: async (_cfg, id) => remote(await api.get("fixture", Number(id))),
    execute: () => "",
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === "bohemia_prepare") {
        assert.equal(args.reset, false);
        git(publicationRoot, "fetch", "origin", "master");
        if (args.sourceCommit) {
          assert.equal(args.sourceCommit, report.commit);
          git(publicationRoot, "checkout", "-b", args.branch, args.sourceCommit);
        } else {
          assert.equal(args.expectedHead, git(publicationRoot, "rev-parse", args.branch));
          git(publicationRoot, "checkout", args.branch);
          if (args.mergeMaster) git(publicationRoot, "merge", "--no-edit", "origin/master");
        }
        return { ready: true, repoRoot: publicationRoot, branch: args.branch,
          commit: git(publicationRoot, "rev-parse", "HEAD") };
      }
      assert.equal(name, "bohemia_check");
      return { ready: true, commit: git(publicationRoot, "rev-parse", "HEAD") };
    },
    reserve: async ({ id, title, branch, commit }) => {
      f.put({ id, title, agent: "spelling", workspace: publicationRoot, session_id: null,
        deferred_pr_owner: true }, "completed");
      const contextFile = path.join(f.store.records, "creator-contexts", `${id}.json`);
      mkdirSync(path.join(f.store.records, "native-creators"), { recursive: true });
      writeJson(contextFile, { version: 2, nativeRoot: f.root, originKind: "spool_automation",
        taskId: id, agent: "spelling", sessionId: null, workspace: publicationRoot, branch, commit,
        receiptDirectory: path.join(f.store.records, "native-creators"), deferred: true });
      return { taskId: id, deferred: true, contextFile };
    },
    publishCall: async (name, args, options) => {
      assert.equal(name, "bohemia_pr");
      assert.equal(options.env.COPILOT_SESSION_ID, "");
      if (args.action === "update") {
        updates++;
        const pr = await api.get("fixture", args.pullRequestId);
        assert.equal(pr.status, "active");
        git(publicationRoot, "push", "origin", pr.sourceRefName.slice(11));
        pr.sourceCommit = git(publicationRoot, "rev-parse", "HEAD");
        return {};
      }
      assert.equal(args.action, "create");
      const context = creationContext(options.env);
      return createWithOrigin({ context, input: { ...args, description: args.solution }, repoRoot: publicationRoot, api });
    },
  };
  return { ...f, publicationRoot, report, runtime, config, api, prs, calls, git, options,
    posts: () => posts, updates: () => updates, publisher: overrides => createSpellingPublisher({ ...options, ...overrides }) };
}
