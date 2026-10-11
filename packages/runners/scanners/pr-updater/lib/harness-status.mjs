/**
 * Ask the harness whether the agent is currently working.
 *
 * This is the authoritative answer and the only one worth trusting. The runner used to decide
 * from its own telemetry alone, which is a record of what this process dispatched rather than of
 * what the agent is doing, so a job that finished a turn, or a second runner process, or a lost
 * state file each read as "free" and the agent was handed the same pull request nine times in
 * forty minutes.
 *
 * The harness publishes agent status on the project listing: `working` while a turn is running,
 * `idle` once it ends, `paused` when the operator stopped it. That is the signal.
 *
 * No regular expressions are used.
 */

/** Agent states that mean a turn is running and nothing new may be handed over. */
const BUSY = ["working", "claimed", "running"];

/** Agent states that mean the agent will never pick the work up, so sending is pointless. */
const STOPPED = ["paused", "disabled"];

/**
 * The agent's current state, as the harness sees it.
 *
 * A failed lookup reports busy. The two directions are not symmetric: pausing costs one poll
 * interval of delay, while guessing "idle" wrongly interrupts an agent mid-turn and overwrites
 * the working tree underneath it, so the unknown case takes the harmless side deliberately.
 */
export async function agentState(config, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const url = `${config.harnessApiUrl}/api/projects`;
  let payload;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`harness returned ${response.status}`);
    payload = await response.json();
  } catch (error) {
    return { busy: true, status: "unknown", reason: `harness status unavailable: ${error.message}` };
  }

  // The endpoint answers with a bare array of projects, not an envelope.
  const projects = Array.isArray(payload) ? payload : payload?.projects || [];
  const project = projects.find((candidate) => candidate?.id === config.harnessProjectId);
  if (!project) {
    return { busy: true, status: "unknown", reason: `harness does not list project ${config.harnessProjectId}` };
  }

  const agent = (project.agents || []).find((candidate) => candidate?.id === config.agentId);
  if (!agent) {
    return { busy: true, status: "unknown", reason: `harness does not list agent ${config.agentId}` };
  }

  const status = String(agent.status || "unknown");
  if (STOPPED.includes(status)) {
    return { busy: true, status, reason: `${config.agentId} is ${status}` };
  }
  if (BUSY.includes(status)) {
    const topic = agent.topic ? ` on ${agent.topic}` : "";
    return { busy: true, status, topic: agent.topic || null, reason: `${config.agentId} is working${topic}` };
  }
  return { busy: false, status, reason: `${config.agentId} is ${status}` };
}
