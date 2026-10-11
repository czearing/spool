import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

export async function queuedReviews(workFolder) {
  let entries;
  try { entries = await readdir(workFolder, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const files = await Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(async entry => ({ name: entry.name, modified: (await stat(path.join(workFolder, entry.name))).mtimeMs })));
  return files.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name)).map(file => file.name);
}

export async function deferReview(file) {
  const now = new Date();
  await utimes(file, now, now);
}

export async function enqueueReview(workFolder, pr, attempt = {}, workspace = null) {
  await mkdir(workFolder, { recursive: true });
  const file = path.join(workFolder, taskFileName(pr, attempt));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, taskBody(pr, attempt, workspace), { encoding: "utf8", flag: "wx" });
  try {
    await link(temporary, file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function taskFileName(pr, attempt = {}) {
  const repository = pr.repository.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const revision = (pr.sourceCommit || "unversioned").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const retry = attempt.retryUpdatedAt
    ? `-retry-${createHash("sha256").update(`${attempt.retryOf}:${attempt.retryUpdatedAt}`).digest("hex").slice(0, 20)}`
    : attempt.retryOf
    ? `-retry-${attempt.retryOf.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(-16).replace(/^-+|-+$/g, "")}`
    : "";
  return `azure-${repository}-pr-${pr.id}-${revision}${retry}.md`;
}

export function taskBody(pr, attempt = {}, workspace = null) {
  const phase = attempt.phase === "revision"
    ? "Re-review of a stable new source revision; CI status is not inferred"
    : "Initial review; start immediately even if CI is still running";
  const ws = workspace || attempt.workspace || null;
  const branch = ws?.branch;
  const repoRoot = ws?.repoRoot;

  const lines = [
    `Review Azure DevOps pull request #${pr.id}: ${pr.title}`,
    `PR URL: ${pr.url}`,
    `Source commit: ${pr.sourceCommit}`,
    ...(branch ? [`Branch: ${branch}`] : []),
    `Phase: ${phase}`,
    ...(attempt.retryOf ? [`Retry of failed Harness task: ${attempt.retryOf}`] : []),
    ...(attempt.retryUpdatedAt ? [`Retry failure updated at: ${attempt.retryUpdatedAt}`] : []),
    ...(pr.preserveExistingVote ? ["The reviewer already voted. Preserve that vote; resume only unfinished review delivery, evidence, notification and task completion. Never repeat a successful external action or overwrite a manual vote."] : []),
  ];

  if (branch && repoRoot) {
    lines.push(
      "",
      `The branch ${branch} is checked out in ${repoRoot} at the source commit and verified clean. Do not run git checkout, fetch, reset, or clean; proceed directly to code analysis and review. Dependency installation is not implied by checkout readiness.`,
    );
  }
  if (ws?.dependencyRepair) lines.push("", `The runner rebuilt the dependency graph for ${ws.dependencyRepair.packages.join(", ")} at the assigned revision. Retry the previously blocked validation against the current artifacts. Do not require a retired dependency solely because stale outputs used to import it.`);

  lines.push(
    "",
    "Use the existing review log, posted threads, vote and notification evidence when resuming; do not repeat completed external actions.",
    "Missing ADO MCP tools alone is not a blocker: use repository-supported PR helpers or authenticated Azure DevOps REST/Azure CLI. Never print credentials.",
    ...(attempt.transport === "spool" ? [
      "Keep the risk map, candidates, and verification evidence in the existing local review log and current Spool task; no separate evidence service is required.",
      "After verifying the required review actions, save evidence with spool_add_comment, mark the current task completed with spool_update_task_status, and confirm it with spool_get_task. If blocked, save the exact cause and mark the task failed. A final chat response alone does not complete the task.",
    ] : [
      "After verifying the required review actions, PATCH the current PAPERCLIP_TASK_ID to done with a concise evidence comment and X-Paperclip-Run-Id: PAPERCLIP_RUN_ID. Verify the returned issue status is done before ending the original run. Posting a final chat response does not close the issue.",
    ]),
    "If genuinely blocked, record the exact blocker and owner on that same issue; do not create duplicate reviews or claim an automatic retry without a persisted continuation.",
  );
  return lines.join("\n");
}

export function retryAttempt(body) {
  const lines = String(body).split("\n");
  const value = prefix => lines.find(line => line.startsWith(prefix))?.slice(prefix.length).trim();
  const retryOf = value("Retry of failed Harness task:");
  const retryUpdatedAt = value("Retry failure updated at:");
  if (!retryOf && !retryUpdatedAt) return null;
  if (!retryOf || !retryUpdatedAt || !Number.isFinite(Date.parse(retryUpdatedAt))) {
    throw new Error("Review retry is missing its original task or failure generation");
  }
  return { retryOf, retryUpdatedAt };
}
