import path from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { engine, enginePath } from "./sources.mjs";
import { digest, readJson, samePath, writeJson } from "./spool-store.mjs";
import { isTaskWorkspace, PREPARATION_BLOCKED } from "../packages/bohemia-pr-mcp/src/resume-state.mjs";
import { withAdmission } from "./admission.mjs";
import { readCreatorResult, resultComment } from "./creator-result.mjs";
import { withHandoffInstructions } from "./managed-settings.mjs";

const { runJob, defaultPrepare } = await engine("pr-updater/lib/pipeline.mjs");
const { readReviewProcedure, reviewPrompt, reviewFindings, reuseDescriptionAnswerBaseline } = await engine("lib/creator-review.mjs");

export async function dispatchCreator(args, { store, config, client, callBohemia, log, resolveCreator,
  preparationEvidence, assertMigrationSafe, harness }) {
  const dispatchConfig = { ...config, harnessProjectId: "spool-creator" };

    let owner;
    try { owner = await resolveCreator(args.pr); }
    catch (error) {
      await log("job_skipped", { pr: args.pr.id, reason: error.message });
      return { dispatched: false, skipped: true, reason: error.message };
    }
    if (!owner.task.session_id && !(owner.originKind === "spool_automation" &&
        owner.deferred === true && owner.task.deferred_pr_owner)) {
      return { dispatched: false, skipped: true, reason: "Original provider session is missing; refusing a replacement conversation" };
    }
    const previousWorkspace = owner.workspace;
    const assigned = owner.originKind === "copilot_cli" ? owner.assignedWorkspace
      : config.agentWorkspaces?.[owner.agent] || owner.assignedWorkspace;
    if (!assigned || !path.isAbsolute(assigned) || isTaskWorkspace(assigned) || !existsSync(assigned)) {
      return { dispatched: false, skipped: true, reason: `Assigned repository is missing or retired for ${owner.agent}; no replacement checkout will be created` };
    }
    const migrating = !samePath(previousWorkspace, assigned);
    if (migrating) {
      owner = { ...owner, workspace: assigned, workspaceMigration: {
        reason: "assigned_agent_workspace", previousWorkspace: owner.task.workspace ?? store.root,
        originalWorkspace: owner.assignedWorkspace, assignedWorkspace: assigned,
      } };
    }
    const admissionWorkspaces = [previousWorkspace, assigned];
    return withAdmission(store.root, owner.agent, async () => {
      try {
        store.assertIdle(owner.agent, owner.workspace);
        if (migrating) {
          store.assertIdle(owner.agent, previousWorkspace);
          assertMigrationSafe(previousWorkspace);
        }
      }
      catch (error) { return { dispatched: false, skipped: true, reason: error.message }; }
      const procedure = await readReviewProcedure();
      const holdFile = path.join(store.records, `preparation-hold-${owner.taskId}.json`);
      const evidence = () => preparationEvidence(owner.workspace, args.pr, owner);
      const initialEvidence = evidence();
      const hold = readJson(holdFile);
      if (hold?.evidence === initialEvidence) {
        return { dispatched: false, skipped: true, reason: hold.reason };
      }
      let prepared, preparedPr;
      const prepareNative = async input => {
        try {
          prepared = await defaultPrepare({ ...input, call: callBohemia, config: {
            ...input.config, repoRoot: owner.workspace, preservePreparedBranch: true, creatorWorkspaceSeed: undefined,
          } });
        } catch (error) {
          if (error.code === PREPARATION_BLOCKED && error.reasonCode === "branch_mismatch") {
            store.assertIdle(owner.agent, owner.workspace);
            prepared = await defaultPrepare({ ...input, call: callBohemia, config: {
              ...input.config, repoRoot: owner.workspace, preservePreparedBranch: true, creatorWorkspaceSeed: undefined,
              checkoutExistingBranch: true,
            } });
          } else {
            if (error.code === PREPARATION_BLOCKED && initialEvidence === evidence()) {
              writeJson(holdFile, { evidence: initialEvidence, reason: error.message, code: error.code,
                taskId: owner.taskId, prId: args.pr.id, at: new Date().toISOString() });
            }
            throw error;
          }
        }
        if (hold) writeJson(holdFile, { clearedAt: new Date().toISOString(), taskId: owner.taskId });
        store.assertIdle(owner.agent, owner.workspace);
        const fresh = await client.getPullRequest(config, args.pr.id, { refresh: true });
        if (fresh.status !== "active" || fresh.isDraft || fresh.sourceCommit !== args.pr.sourceCommit || fresh.branch !== args.pr.branch) {
          throw new Error("PR revision changed during preparation; creator handoff held");
        }
        preparedPr = fresh;
        return prepared;
      };
      const prepare = input => config.eventPipeline ? config.eventPipeline.prepare({
        prId: args.pr.id, sourceCommit: args.pr.sourceCommit, branch: args.pr.branch,
        fingerprint: args.verdict.fingerprint, workspace: owner.workspace,
      }, () => prepareNative(input)) : prepareNative(input);
      const deliver = {
        ...harness,
        async findSubmission(key) { return store.submission(key); },
        async submitAgentTask(_config, _agent, _prompt, key, { pr, verdict }) {
          if (!prepared?.ready || !preparedPr) throw new Error("Creator handoff requires verified preparation");
          const threads = await client.listThreads(config, pr.id, { fresh: true });
          let contract = { version: 2, submissionId: key, fingerprint: verdict.fingerprint,
            resultFile: path.join(store.records, "results", `${digest(key)}.json`),
            prId: String(pr.id), head: pr.sourceCommit, branch: pr.branch, url: pr.url,
            cwd: owner.workspace, identifier: owner.taskId, agent: owner.agent,
            agentName: owner.creatorName, workspaceHead: prepared.commit,
            responseMode: "pr_description", descriptionBaseline: preparedPr.description || "",
            findings: reviewFindings(threads, config),
            ...(["conflict", "build"].includes(verdict.trigger) ? { repair: { type: verdict.trigger, reason: verdict.reason } } : {}),
          };
          mkdirSync(path.dirname(contract.resultFile), { recursive: true });
          contract = reuseDescriptionAnswerBaseline(contract, store.metadata(owner.taskId)?.contract,
            readJson(path.join(store.records, `verification-${owner.taskId}.json`))?.result, preparedPr);
          if (!contract.previousAnswerSubmissionId) {
            for (const comment of [...(owner.task.comments || [])].reverse()) {
              const text = comment.message || comment.content || "";
              if (!resultComment(text)) continue;
              let result;
              try { result = readCreatorResult(store, owner.task, text); }
              catch (error) {
                await log("historical_result_invalid", { pr: pr.id, reason: error.message });
                continue;
              }
              const receipt = typeof result?.submissionId === "string" ? store.receipt(result.submissionId) : null;
              if (receipt?.phase !== "published" || receipt.taskId !== owner.taskId || receipt.prId !== String(pr.id)) continue;
              contract = reuseDescriptionAnswerBaseline(contract, receipt.contract, result, preparedPr);
              if (contract.previousAnswerSubmissionId) break;
            }
          }
          const roleFile = path.join(store.root, "agents", `${owner.agent}.md`);
          const roleInstructions = readFileSync(roleFile, "utf8").replace(/^\uFEFF/, "")
            .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
          if (!roleInstructions) throw new Error("Current creator instructions are empty; feedback handoff held");
          const prompt = reviewPrompt(contract, withHandoffInstructions(procedure, config.handoffInstructions),
            { transport: "spool", roleInstructions });
          const submit = taskPrompt => store.submit({ key, agent: owner.agent, title: owner.task.title, prompt: taskPrompt,
            workspace: owner.workspace, resumeId: owner.taskId, expectedUpdatedAt: owner.task.updated_at, metadata: {
              runner: "pr-updater", prId: String(pr.id), sourceCommit: pr.sourceCommit,
              independentWorkspace: false,
              updatePrompt: { source: enginePath("pr-updater", "review-mode.md"),
                procedureSha256: digest(procedure), promptSha256: digest(taskPrompt), transport: "spool",
                roleSource: roleFile, roleSha256: digest(roleInstructions) },
              preparation: prepared, contract, creator: { taskId: owner.taskId, sourceAgentId: owner.sourceAgentId, sourceIssueId: owner.sourceIssueId },
              ...(owner.workspaceMigration ? { workspaceMigration: owner.workspaceMigration } : {}),
            } });
          return config.eventPipeline ? config.eventPipeline.deliver({ prompt, agent: owner.agent, taskId: owner.taskId }, submit) : submit(prompt);
        },
      };
      return runJob({ ...args, config: { ...dispatchConfig, agentId: owner.agent, repoRoot: owner.workspace,
        preparationEvidence: initialEvidence }, harness: deliver, prepare, log });
    }, admissionWorkspaces).then(result => result.holding ? { ...result, dispatched: false, skipped: true, reason: result.holding } : result);
  
}
