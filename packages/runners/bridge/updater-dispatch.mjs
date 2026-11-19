import path from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { engine } from "./sources.mjs";
import { digest, readJson, samePath, writeJson } from "./spool-store.mjs";
import { isTaskWorkspace, PREPARATION_BLOCKED } from "../packages/bohemia-pr-mcp/src/resume-state.mjs";
import { withAdmission } from "./admission.mjs";
import { readCreatorResult, creatorResultHistory } from "./creator-result.mjs";
import { withHandoffInstructions } from "./managed-settings.mjs";
import { fileURLToPath } from "node:url";
import { stageCreatorReview } from "../packages/repository-mcp/src/codespaces/creator-review.mjs";
import { CodespaceRequests } from "../packages/repository-mcp/src/codespaces/github-requests.mjs";

const { runJob, defaultPrepare } = await engine("pr-updater/lib/pipeline.mjs");
const { readReviewProcedure, reviewPrompt, reviewFindings, reviewReplyRequired, reuseDescriptionAnswerBaseline, withSpoolReviewTools } =
  await engine("lib/creator-review.mjs");

const workflowFiles = ["../scanners/pr-updater/lib/pipeline.mjs", "../packages/bohemia-pr-mcp/src/operations.mjs",
    "../packages/dedicated-runners/repo-gates/bohemia.ps1",
    "../packages/bohemia-pr-mcp/src/test-runtime.mjs", "../packages/bohemia-pr-mcp/src/browser-runtime.mjs",
    "../packages/bohemia-pr-mcp/src/tools.ts",
    "../packages/bohemia-agent-tooling/src/request-queue.js",
    "../packages/bohemia-pr-mcp/src/index.ts", "../packages/repository-mcp/src/index.mjs",
    "../packages/bohemia-pr-mcp/src/prepare-branch.mjs", "./updater-dispatch.mjs", "../scanners/lib/creator-review.mjs",
    "../packages/repository-mcp/src/adapters/1js-setup.mjs",
    "../packages/repository-mcp/src/codespaces/engineering.mjs",
    "../packages/repository-mcp/src/codespaces/recovery.mjs",
    "../packages/repository-mcp/src/codespaces/creator-review.mjs",
    "../packages/repository-mcp/src/codespaces/transport.mjs",
    "../packages/repository-mcp/src/codespaces/native.mjs",
    "../packages/repository-mcp/src/codespaces/azure-auth.mjs",
    "../packages/repository-mcp/src/codespaces/application-vm.mjs",
    "../packages/repository-mcp/src/codespaces/github-requests.mjs",
    "../packages/repository-mcp/src/codespaces/command-channel.mjs",
    "../packages/repository-mcp/src/codespaces/copilot.mjs",
    "./setup-dependency.mjs",
    "./message-receipt.mjs", "./file-watch.mjs", "./control-identity.mjs", "./task-records.mjs", "./creator-result.mjs",
    "./native-continuation.mjs", "./monitor-controls.mjs", "./updater.mjs",
    "./publications.mjs", "./creator-routing.mjs"];
const spellingWorkflowFiles = ["../scanners/spelling/repair.mjs",
    "../scanners/spelling/repair-context.mjs", "../scanners/spelling/publication-continuity.mjs",
    "../scanners/spelling/check.mjs", "../scanners/spelling/quality.md"];

export function snapshotWorkflowSources(readSource = readFileSync) {
  const sources = new Map([...workflowFiles, ...spellingWorkflowFiles].map(file => {
    const absolute = fileURLToPath(new URL(file, import.meta.url));
    return [absolute, readSource(absolute, "utf8")];
  }));
  return file => {
    if (!sources.has(file)) throw new Error(`Unknown creator workflow source: ${file}`);
    return sources.get(file);
  };
}
const loadedWorkflowSource = snapshotWorkflowSources();

export function creatorWorkflowEvidence(store, owner, readSource = loadedWorkflowSource) {
  const files = [...workflowFiles, ...(owner.agent === "spelling" ? spellingWorkflowFiles : [])];
  return digest(JSON.stringify([readFileSync(path.join(store.root, "agents", `${owner.agent}.md`), "utf8"),
    readFileSync(path.join(store.root, "agents", "pr-updater.md"), "utf8"),
    readJson(path.join(store.records, `setup-dependency-${owner.taskId}.json`)),
    ...files.map(file => readSource(fileURLToPath(new URL(file, import.meta.url)), "utf8"))]));
}

export function creatorTransportHold(store, owner) {
  const provider = readJson(path.join(store.root, "spool.json"))?.copilotProviders?.[owner.agent];
  const args = provider?.args, index = Array.isArray(args) ? args.indexOf("--config") : -1;
  const profile = index >= 0 && path.isAbsolute(args[index + 1] || "") ? readJson(args[index + 1]) : null;
  if (!profile?.githubAccount) return null;
  try { new CodespaceRequests(profile.githubAccount).check(profile.codespace); }
  catch (error) {
    if (!["GITHUB_RATE_LIMITED", "CODESPACE_UNAVAILABLE"].includes(error.code)) throw error;
    return { reason: error.message, retryAt: error.retryAt };
  }
  return null;
}

export async function dispatchCreator(args, { store, config, client, callBohemia, log, resolveCreator,
  preparationEvidence, workflowEvidence = creatorWorkflowEvidence,
  transportHold = creatorTransportHold, assertMigrationSafe, harness }) {
  const dispatchConfig = { ...config, harnessProjectId: "spool-creator" };
  const codespace = config.repositoryProfile === "1js";

    let owner;
    try { owner = await resolveCreator(args.pr); }
    catch (error) {
      await log("job_skipped", { pr: args.pr.id, reason: error.message });
      return { dispatched: false, skipped: true, reason: error.message };
    }
    if (!owner.task.session_id && !(owner.deferred === true &&
        (owner.task.deferred_session || owner.task.deferred_pr_owner))) {
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
          if (!codespace) assertMigrationSafe(previousWorkspace);
        }
      }
      catch (error) { return { dispatched: false, skipped: true, reason: error.message }; }
      const deferred = codespace && await transportHold(store, owner);
      if (deferred) {
        await log("job_skipped", { pr: args.pr.id, reason: deferred.reason });
        return { dispatched: false, skipped: true, ...deferred };
      }
      await readReviewProcedure(store.root);
      const holdFile = path.join(store.records, `preparation-hold-${owner.taskId}.json`);
      const repairWorkflowEvidence = workflowEvidence(store, owner);
      const evidence = () => `${codespace ? digest(JSON.stringify([
        config.repositoryMcpConfig, owner.workspace, owner.task.session_id,
        args.pr.id, args.pr.sourceCommit, args.pr.targetCommit,
      ])) : preparationEvidence(owner.workspace, args.pr, owner)}:${repairWorkflowEvidence}`;
      const initialEvidence = evidence();
      const hold = readJson(holdFile);
      if (!codespace && hold?.evidence === initialEvidence) {
        return { dispatched: false, skipped: true, reason: hold.reason };
      }
      let prepared, preparedPr;
      const prepareNative = async input => {
        try {
          prepared = await defaultPrepare({ ...input, call: callBohemia, config: {
            ...input.config, repoRoot: owner.workspace, preservePreparedBranch: true, creatorWorkspaceSeed: undefined,
          } });
        } catch (error) {
          if (!codespace && error.code === PREPARATION_BLOCKED && error.reasonCode === "branch_mismatch") {
            store.assertIdle(owner.agent, owner.workspace);
            try {
              prepared = await defaultPrepare({ ...input, call: callBohemia, config: {
                ...input.config, repoRoot: owner.workspace, preservePreparedBranch: true, creatorWorkspaceSeed: undefined,
                checkoutExistingBranch: true,
              } });
            } catch (checkoutError) {
              if (checkoutError.code !== PREPARATION_BLOCKED) throw checkoutError;
              store.assertIdle(owner.agent, owner.workspace);
              prepared = await defaultPrepare({ ...input, call: callBohemia, config: {
                ...input.config, repoRoot: owner.workspace, preservePreparedBranch: true, creatorWorkspaceSeed: undefined,
                checkoutExistingBranch: false,
              } });
            }
          } else {
            if (!codespace && error.code === PREPARATION_BLOCKED && initialEvidence === evidence()) {
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
          let findings = reviewFindings(threads, config);
          const previous = store.metadata(owner.taskId);
          const verification = readJson(path.join(store.records, `verification-${owner.taskId}.json`));
          if (verdict.retry && verification?.ok === false &&
              verification.submissionId === previous?.key && verification.head === pr.sourceCommit) {
            const pending = new Set((verification.result?.findings || []).filter(row =>
              row.disposition === "blocked" && previous.contract?.findings?.some(finding => finding.threadId === row.threadId))
              .map(row => row.threadId));
            const unfinished = reviewFindings(threads.filter(thread => pending.has(String(thread.id)))
              .map(thread => ({ ...thread, status: "active" })), config);
            findings = [...findings, ...unfinished.filter(finding => !findings.some(row => row.threadId === finding.threadId))];
          }
          let contract = { version: 2, submissionId: key, fingerprint: verdict.fingerprint, at: new Date().toISOString(),
            resultFile: path.join(store.records, "results", `${digest(key)}.json`),
            contractFile: path.join(store.records, "contracts", `${digest(key)}.json`),
            creatorRoleFile: path.join(store.root, "agents", `${owner.agent}.md`),
            prId: String(pr.id), head: pr.sourceCommit, branch: pr.branch, url: pr.url,
            cwd: owner.workspace, identifier: owner.taskId, agent: owner.agent,
            agentName: owner.creatorName, workspaceHead: prepared.commit,
            repositoryProfile: config.repositoryProfile,
            responseMode: "pr_description", replyPolicy: "never", resolutionMode: "runner",
            descriptionBaseline: preparedPr.description || "",
            replyThreadIds: [],
            findings,
            ...(config.repositoryConfigFile ? { repositoryConfigFile: config.repositoryConfigFile } : {}),
            ...(["conflict", "build"].includes(verdict.trigger) ? { repair: { type: verdict.trigger, reason: verdict.reason } } : {}),
          };
          mkdirSync(path.dirname(contract.resultFile), { recursive: true });
          contract = reuseDescriptionAnswerBaseline(contract, store.metadata(owner.taskId)?.contract,
            readJson(path.join(store.records, `verification-${owner.taskId}.json`))?.result, preparedPr);
          if (!contract.previousAnswerSubmissionId && !contract.previousFixSubmissionId) {
            for (const key of creatorResultHistory(store)(owner.task)) {
              let result;
              try { result = readCreatorResult(store, owner.task, key); }
              catch (error) {
                await log("historical_result_invalid", { pr: pr.id, reason: error.message });
                continue;
              }
              const receipt = typeof result?.submissionId === "string" ? store.receipt(result.submissionId) : null;
              if (receipt?.phase !== "published" || receipt.taskId !== owner.taskId || receipt.prId !== String(pr.id)) continue;
              contract = reuseDescriptionAnswerBaseline(contract, receipt.contract, result, preparedPr);
              if (contract.previousAnswerSubmissionId || contract.previousFixSubmissionId) break;
            }
          }
          contract = withSpoolReviewTools(contract);
          mkdirSync(path.dirname(contract.contractFile), { recursive: true });
          const roleFile = contract.creatorRoleFile;
          const roleInstructions = readFileSync(roleFile, "utf8").replace(/^\uFEFF/, "")
            .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
          if (!roleInstructions) throw new Error("Current creator instructions are empty; feedback handoff held");
          if (codespace && prepared.execution?.kind === "codespace")
            contract = await stageCreatorReview(prepared, contract, roleInstructions);
          writeJson(contract.contractFile, contract);
          const procedure = await readReviewProcedure(store.root);
          const prompt = reviewPrompt(contract, withHandoffInstructions(procedure, config.handoffInstructions),
            { transport: "spool" });
          const submit = taskPrompt => store.submit({ key, agent: owner.agent, title: owner.task.title, prompt: taskPrompt,
            workspace: owner.workspace, resumeId: owner.taskId, expectedUpdatedAt: owner.task.updated_at, metadata: {
              runner: "pr-updater", prId: String(pr.id), sourceCommit: pr.sourceCommit,
              repairWorkflowEvidence,
              independentWorkspace: false,
              updatePrompt: { source: path.join(store.root, "agents", "pr-updater.md"),
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
