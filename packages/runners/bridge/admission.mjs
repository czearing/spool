import { acquireProcessLock } from "../packages/bohemia-agent-tooling/src/index.js";
import { canonicalPath, safeId } from "./spool-store.mjs";

async function lockResource(resource, action) {
  let release;
  try {
    release = await acquireProcessLock(resource, { namespace: "spool-runner" });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    return { holding: "Another runner is scanning or preparing this agent/workspace", dispatched: 0 };
  }
  try { return await action(); }
  finally { await release(); }
}

export async function withAdmission(spoolRoot, agent, action, workspace, taskId = null) {
  const root = canonicalPath(spoolRoot);
  const workspaces = [...new Set((Array.isArray(workspace) ? workspace : workspace ? [workspace] : [])
    .map(canonicalPath))].sort();
  const enter = index => index === workspaces.length ? action()
    : lockResource(`workspace:${workspaces[index]}`, () => enter(index + 1));
  return lockResource(taskId ? `${root}:task:${safeId(taskId)}` : `${root}:agent:${agent}`, () => enter(0));
}
