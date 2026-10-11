import { readTodoJson } from "./todo-schema.js";

/**
 * Creates an autonomous queue supervisor that coordinates between paperclip issues,
 * PR limits, and manager wake triggers without duplicate logic across scripts.
 */
export function createQueueSupervisor({
  apiUrl = process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3400",
  companyId = process.env.PAPERCLIP_COMPANY_ID || "b15271fe-75c2-4273-b08e-08c41b2101c2",
  runnerName = "Queue Supervisor",
  agentName = "SupervisorAgent",
  agentId,
  projectId = null,
  managerAgentId,
  maxOpenPrs = 3,
  countOpenPrs = null,
  checkWakeManager = null,
  triggerCycle = null,
  prepareTask = null,
  fetchImpl = fetch,
  todoJsonPath = null,
  pollIntervalMs = 30_000,
  logger = console.log,
} = {}) {
  async function getJson(endpoint) {
    const res = await fetchImpl(`${apiUrl}${endpoint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}`);
    return res.json();
  }

  async function patchJson(endpoint, body) {
    const res = await fetchImpl(`${apiUrl}${endpoint}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} patching ${endpoint}`);
    return res.json();
  }

  async function wakeAgent(id, reason, issueId) {
    try {
      const response = await fetchImpl(`${apiUrl}/api/agents/${id}/wakeup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason || "Task assigned", issueId }),
      });
      if (!response.ok) throw new Error(`Agent wake failed: HTTP ${response.status}`);
    } catch (error) {
      logger(`[supervisor] Agent wake failed: ${error.message}`);
      throw error;
    }
  }

  async function getOpenPrCount(issues) {
    if (typeof countOpenPrs === "function") {
      return await countOpenPrs();
    }
    const inReview = issues.filter((i) => {
      if (projectId) return i.projectId === projectId && i.status === "in_review";
      return i.assigneeAgentId === agentId && i.status === "in_review";
    });
    return inReview.length;
  }

  async function step() {
    let issues = await getJson(`/api/companies/${companyId}/issues`);
    let agentIssues = issues.filter((i) => i.assigneeAgentId === agentId && (!projectId || i.projectId === projectId));

    let inProgress = agentIssues.filter((i) => ["in_progress", "todo"].includes(i.status));
    let backlog = agentIssues.filter((i) => i.status === "backlog");
    const openPrs = await getOpenPrCount(issues);

    // 1. Promote backlog to 'todo' if slots open
    if (inProgress.length === 0 && openPrs < maxOpenPrs && backlog.length > 0) {
      const nextTask = backlog[0];
      const preparation = prepareTask ? await prepareTask(nextTask) : {};
      const current = await getJson(`/api/issues/${nextTask.id}`);
      if (current?.status !== "backlog" || current.assigneeAgentId !== agentId || current.assigneeUserId) {
        throw new Error("Backlog ownership changed during preparation; handoff held");
      }
      logger(`[supervisor] Promoting [${nextTask.identifier}] "${nextTask.title}" from backlog to todo (PRs: ${openPrs}/${maxOpenPrs})`);
      const promoted = await patchJson(`/api/issues/${nextTask.id}`, { ...preparation, status: "todo" });
      if (promoted?.id !== nextTask.id || promoted.status !== "todo") throw new Error("Paperclip did not confirm the prepared backlog handoff");
      await wakeAgent(agentId, "Promoted task from backlog to todo", nextTask.id);
    }
    // 2. Or trigger cycle if no active or backlog tasks and slots available
    else if (inProgress.length === 0 && openPrs < maxOpenPrs && backlog.length === 0 && typeof triggerCycle === "function") {
      logger(`[supervisor] Slot free (${openPrs}/${maxOpenPrs} PRs) and no backlog task: running cycle to dispatch next item...`);
      try {
        const cycleRes = await triggerCycle();
        if (cycleRes?.issueId) {
          logger(`[supervisor] Dispatched new issue [${cycleRes.issueIdentifier || cycleRes.issueId}] via cycle`);
          await wakeAgent(agentId, "New performance task dispatched", cycleRes.issueId);
        }
      } catch (err) {
        logger(`[supervisor] Error running cycle: ${err.message}`);
        throw err;
      }
    }

    // 3. If agent has a 'todo' task and is currently idle, wake it immediately
    issues = await getJson(`/api/companies/${companyId}/issues`);
    agentIssues = issues.filter((i) => i.assigneeAgentId === agentId);
    const todoTasks = agentIssues.filter((i) => i.status === "todo");
    if (todoTasks.length > 0) {
      try {
        const agent = await getJson(`/api/agents/${agentId}`);
        if (agent?.status === "idle") {
          logger(`[supervisor] Waking idle agent [${agent.name || agentId}] for task [${todoTasks[0].identifier || todoTasks[0].id}]`);
          await wakeAgent(agentId, "Actionable todo task waiting", todoTasks[0].id);
        }
      } catch (error) {
        logger(`[supervisor] Error checking idle agent: ${error.message}`);
        throw error;
      }
    }

    // 4. Evaluate wake triggers if manager configured
    let wakeResult = null;
    if (typeof checkWakeManager === "function") {
      wakeResult = await checkWakeManager({ apiUrl, companyId, threshold: 5 });
      if (wakeResult?.woken) {
        logger(`[supervisor] Woke manager [${wakeResult.identifier}] (${wakeResult.reason})`);
      }
    }

    // The shared runner lifecycle owns persistence and failure reporting.
    const nextScan = new Date(Date.now() + pollIntervalMs).toISOString();
    const todoData = readTodoJson(todoJsonPath);
    return {
      name: runnerName,
      agent: agentName,
      nextScan,
      pollSeconds: Math.round(pollIntervalMs / 1000),
      open: inProgress.length + backlog.length,
      actionable: backlog.length,
      openPrs,
      maxOpenPrs,
      todoState: todoData ? {
        openCount: todoData.queueCap?.open,
        isCapClosed: todoData.queueCap?.isClosed,
        remainingSlots: todoData.queueCap?.remainingSlots,
      } : null,
      lastWakeResult: wakeResult ? { woken: wakeResult.woken, reason: wakeResult.reason } : null,
    };
  }

  return { step };
}
