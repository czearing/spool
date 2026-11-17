import fs from "node:fs";
import path from "node:path";
import { readCodespaceConfig, resolveControlWorkspace } from "./config.mjs";
import { CodespaceReview, verifySavedCodespace } from "./review.mjs";
import { CodespaceTransport } from "./transport.mjs";
import { validateRepositoryInput } from "../adapters/1js.mjs";
import { reviewRevisionUpdateMessage } from "../review-outcome.mjs";

export function withCodespaceReviewer(local, file, dependencies = {}) {
  const readConfig = dependencies.readConfig || readCodespaceConfig;
  const config = readConfig(file, { validateLocalPaths: false });
  const verify = dependencies.verify || verifySavedCodespace;
  const Session = dependencies.Session || CodespaceReview;
  let session, disposing = false;
  return {
    id: local.id,
    async tools() {
      return (await local.tools()).map(tool => tool.operation !== "prepare" ? tool : {
        ...tool, description: `${tool.description} Reviewer control workspaces require reviewPullRequestId and exact sourceCommit; the MCP owns the review lifecycle. During an owned review, operation master refreshes target refs without switching the checkout or rerunning setup.`,
        inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
          reviewPullRequestId: { type: "integer", minimum: 1, description: "Registered Codespace reviewer only: prepare this exact assigned PR." } } },
      });
    },
    async dispose() {
      disposing = true;
      if (session) { await session.dispose(); session = undefined; }
      await local.dispose?.();
    },
    async call(operation, input, context) {
      if (resolveControlWorkspace(input?.repoRoot) !== config.workspace)
        return local.call(operation, input, context);
      readConfig(file);
      const setup = operation === "prepare" && input.operation === "setup";
      const refresh = operation === "prepare" && input.operation === "master";
      if (refresh && (input.reset || input.mergeMaster || input.branch || input.mode || input.sourceCommit ||
          input.expectedHead || input.runSetup === true || input.runBuild === true))
        throw new Error("Reviewer target refresh fetches refs only; it cannot switch, reset or merge the working checkout");
      if (operation === "prepare" && !setup && !refresh) {
        const { reviewPullRequestId, ...request } = input;
        validateRepositoryInput("prepare", request);
        if (!context?.codespaceLifecycle) throw new Error("Reviewer repo_prepare requires an owned MCP lifecycle");
        if (!Number.isSafeInteger(reviewPullRequestId) || reviewPullRequestId < 1 ||
            request.operation !== "branch" || request.mode !== "checkout" ||
            !/^[a-f0-9]{40}$/i.test(request.sourceCommit || "") ||
            request.branch !== `review/pr-${reviewPullRequestId}-${request.sourceCommit.slice(0, 12)}` ||
            request.reset || request.mergeMaster || request.runSetup === false || request.runBuild === false ||
            request.baseBranch && request.baseBranch !== "main")
          throw new Error("Reviewer preparation requires the exact PR identity, non-resetting branch checkout, setup and build");
        if (session) throw new Error("This MCP session already owns a reviewer workspace");
        session = new Session(config.file, { config });
        try {
          const result = await session.prepare({ prId: reviewPullRequestId, sourceCommit: request.sourceCommit,
            repoRoot: config.workspace });
          for (const child of session.transport?.children || []) child.once("exit", () => {
            if (!disposing) context.onLifecycleFailure?.("Owned Codespace connection/runtime exited");
          });
          return { content: [{ type: "text", text: `Codespace reviewer prepared at ${result.commit}` }],
            structuredContent: result, isError: false };
        } catch (error) {
          disposing = true;
          await session.dispose();
          session = undefined;
          throw error;
        }
      }
      if (!["build", "check"].includes(operation) && !setup && !refresh)
        throw new Error("Codespace review is read-only: the runner owns preparation; publication and scope changes are refused");
      validateRepositoryInput(operation, input);
      const receiptFile = path.join(config.workspace, "preparation.json");
      const prepared = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
      const before = await verify(prepared, { allowRevisionDrift: true });
      const transport = dependencies.transport || new CodespaceTransport(config);
      await transport.environment();
      transport.leaseToken = prepared.leaseToken;
      transport.azureAuthFile = `${config.remoteTools}/azure-auth.json`;
      const result = await transport.native(operation, { ...input, repoRoot: config.remoteRoot,
        ...(refresh ? { runSetup: false, runBuild: false } : {}) },
        prepared.comparison?.files);
      if (!result.ready || result.commit !== prepared.commit)
        throw new Error("Remote repository operation did not verify the assigned PR revision");
      const after = await verify(prepared, { allowRevisionDrift: true });
      const revisionUpdate = after || before;
      return { content: [{ type: "text", text: `Remote repository ${operation} passed at ${result.commit}` +
        (revisionUpdate ? `\n${reviewRevisionUpdateMessage(revisionUpdate)}` : "") }],
        structuredContent: { ...result, ...(revisionUpdate ? { revisionUpdate } : {}) }, isError: false };
    },
  };
}
