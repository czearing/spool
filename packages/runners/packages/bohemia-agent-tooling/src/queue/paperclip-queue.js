/**
 * Queue client for the issue queue. Generic: it knows about issues, not about any one tool.
 */
import { buildPark } from "../park.js";
import {
  guardIssueWrites,
  isRunContextRefusal,
  readRunContext,
  RunContextHeldError,
} from "../run-context.js";

export function createPaperclipQueue({
  baseUrl,
  apiKey,
  companyId,
  runId,
  sourceIssueId,
  env = typeof process === "undefined" ? {} : process.env,
  fetchImpl = fetch,
}) {
  const resolvedBaseUrl = baseUrl || env.PAPERCLIP_API_URL || "http://127.0.0.1:3400";
  const resolvedCompanyId = companyId || env.PAPERCLIP_COMPANY_ID || "b15271fe-75c2-4273-b08e-08c41b2101c2";
  const resolvedApiKey = apiKey || env.PAPERCLIP_API_KEY || null;

  if (!resolvedBaseUrl) throw new Error("queue requires a base url");
  if (!resolvedCompanyId) throw new Error("queue requires a company id");

  const root = resolvedBaseUrl.replace(/\/+$/, "");

  /**
   * What the queue can attribute a write to. The run id is what the request carries, and the source
   * issue is what the control plane looks for behind it, so both are read here rather than left for
   * each caller to discover from a refusal.
   */
  const fromEnv = readRunContext(env ?? {});
  const runContext = readRunContext({
    PAPERCLIP_RUN_ID: runId ?? fromEnv.runId ?? undefined,
    PAPERCLIP_TASK_ID: (sourceIssueId === undefined ? fromEnv.sourceIssueId : sourceIssueId) ?? undefined,
  });

  async function request(method, path, body) {
    const headers = {
      "Content-Type": "application/json",
    };
    if (resolvedApiKey) {
      headers["Authorization"] = `Bearer ${resolvedApiKey}`;
    }
    if (runContext.runId) headers["X-Paperclip-Run-Id"] = runContext.runId;

    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      /**
       * A refusal is answered by code, never by reading the sentence back. The code is lifted out of
       * the body and put on the error, because a caller that has to tell one refusal from another
       * cannot depend on the wording surviving a truncated message.
       */
      let details = null;
      try {
        details = text ? JSON.parse(text)?.details ?? null : null;
      } catch {
        details = null;
      }
      const code = typeof details?.code === "string" ? details.code : null;
      const error = new Error(
        `queue ${method} ${path} failed with ${response.status}${code ? ` (${code})` : ""}: ${text.slice(0, 300)}`,
      );
      error.status = response.status;
      error.details = details;
      if (code) error.code = code;
      /**
       * A refusal for want of a run to attribute the write to is a hold rather than a failure, and it
       * is raised as one whether the guard caught it first or the control plane did. A caller must
       * not have to tell the two apart to know the write is still to be made.
       */
      if (isRunContextRefusal(error)) {
        const held = new RunContextHeldError(error.message, runContext);
        held.status = response.status;
        held.details = details;
        throw held;
      }
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  const client = {
    async createIssue(issue) {
      return request("POST", `/api/companies/${companyId}/issues`, {
        title: issue.title,
        description: issue.description,
        assigneeAgentId: issue.assigneeAgentId,
        parentId: issue.parentId,
        /**
         * The project the work belongs to. An issue written without one is created with no project
         * and therefore no workspace, and the agent that picks it up starts in an empty directory
         * with no checkout of the repository the task is about. It is sent only when the caller
         * names one, so a tool that genuinely has no project keeps the previous behaviour.
         */
        ...(issue.projectId ? { projectId: issue.projectId } : {}),
        priority: issue.priority ?? "medium",
        status: issue.status ?? "todo",
      });
    },
    async getIssue(issueId) {
      return request("GET", `/api/issues/${issueId}`);
    },
    async getComments(issueId) {
      const comments = await request("GET", `/api/issues/${issueId}/comments`);
      return Array.isArray(comments) ? comments : [];
    },
    /**
     * Every issue in the company. A tool that hands work to an agent has to read its own results
     * back, and the queue is the only place that record survives a restart.
     */
    async listIssues() {
      const issues = await request("GET", `/api/companies/${companyId}/issues`);
      if (Array.isArray(issues)) return issues;
      if (Array.isArray(issues?.issues)) return issues.issues;
      throw new Error("Paperclip returned an invalid issue list");
    },
    async listLiveRuns() {
      const runs = await request("GET", `/api/companies/${resolvedCompanyId}/live-runs?limit=1000&minCount=0`);
      if (!Array.isArray(runs)) throw new Error("Paperclip returned an invalid live-run list");
      return runs;
    },
    async updateIssue(issueId, update) {
      return request("PATCH", `/api/issues/${issueId}`, update);
    },
    /**
     * Withdraw work that should not be done. This is a status change rather than a delete because
     * the record of what was asked for, and that it was called off, is the useful part.
     */
    async cancelIssue(issueId, reason) {
      return request("PATCH", `/api/issues/${issueId}`, {
        status: "cancelled",
        ...(reason ? { comment: reason } : {}),
      });
    },
    /**
     * Park work that cannot proceed. The wake path is built before the write, so a park with nothing
     * that can undo it is refused here and never reaches the board.
     *
     * The endpoint takes the blocker relation and the unblock descriptor on the same write. A monitor
     * is scheduled on its own surface, so when one is asked for it is carried back to the caller
     * rather than folded into a field the endpoint does not accept.
     */
    async parkIssue(issueId, park) {
      const built = buildPark(park);
      const issue = await request("PATCH", `/api/issues/${issueId}`, {
        ...built.update,
        ...(park?.comment ? { comment: park.comment } : {}),
      });
      return { issue, wakePaths: built.wakePaths, monitorNextCheckAt: built.monitorNextCheckAt };
    },
  };

  client.runContext = runContext;
  return guardIssueWrites(client, runContext);
}
