import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { publicationForTask } from "./publications.mjs";
import { fileURLToPath } from "node:url";
import { acquireProcessLock } from "../packages/bohemia-agent-tooling/src/index.js";
import { readJson, writeJson, safeId, samePath } from "./spool-store.mjs";
import { queueCiValidation, publishAcceptedCiExperiment } from "./ci-experiment.mjs";
import { ciExecutionContext, completeCiExecution } from "./ci-execution.mjs";

export function ciExperimentContract(store) {
  return { version: 1, directory: path.join(store.records, "ci-jobs"),
    historyFile: path.join(store.records, "ci-history.md"), helper: fileURLToPath(import.meta.url) };
}
export function ciJobContext(store, taskId) {
  safeId(taskId);
  const task = store.task(taskId) || store.withdrawn(taskId);
  const expected = ciExperimentContract(store);
  const current = store.metadata(taskId);
  const metadata = current?.handoff?.ciExperiment ? current :
    readJson(path.join(expected.directory, `${taskId}.json`))?.origin;
  const contract = metadata?.handoff?.ciExperiment;
  if (task?.agent !== "ci" || !metadata?.handoff?.discovery || !metadata.preparation?.ready ||
      !samePath(task.workspace, metadata.preparation.repoRoot) ||
      contract?.version !== 1 || !samePath(contract.directory, expected.directory) ||
      !samePath(contract.historyFile, expected.historyFile)) {
    throw new Error("CI outcomes require the original prepared CI discovery task and memory contract");
  }
  return { task, metadata, contract, file: path.join(contract.directory, `${taskId}.json`) };
}
export async function withCiJobLock(store, taskId, action) {
  ciJobContext(store, taskId);
  const release = await acquireProcessLock(path.resolve(store.records).toLowerCase(),
    { namespace: "ci-experiment", timeoutMs: 30_000 });
  try { return await action(); } finally { await release(); }
}
export function readCiJob(store, taskId) {
  const context = ciJobContext(store, taskId), job = readJson(context.file);
  if (job && (job.version !== 1 || job.taskId !== taskId ||
      job.branch !== context.metadata.preparation.branch || !samePath(job.workspace, context.task.workspace))) {
    throw new Error("CI outcome record does not match its original task and branch");
  }
  return job;
}
export function ciJobs(store) {
  const directory = ciExperimentContract(store).directory;
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith(".json")).map(name => readCiJob(store, name.slice(0, -5)));
}
function text(value, field, limit = 300) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\r\n]/.test(value))
    throw new Error(`CI ${field} must be concise nonempty single-line text (maximum ${limit} characters)`);
  return value.trim();
}
export function refreshCiHistory(store) {
  const contract = ciExperimentContract(store);
  mkdirSync(store.records, { recursive: true });
  const rows = ciJobs(store).flatMap(job => job ? [
    ...(job.priorOutcomes || []).map(previous => ({ ...job, ...previous })),
    ...(job.outcome ? [job] : []),
  ] : []).sort((a, b) =>
    b.outcome.recordedAt.localeCompare(a.outcome.recordedAt)).slice(0, 20);
  const escape = value => value.replaceAll("|", "\\|");
  writeFileSync(contract.historyFile, [
    "# CI outcomes", "", "Read before choosing work; begin rejects every previously attempted candidate key.",
    "Detailed evidence stays in the linked per-task record.", "",
    "| Candidate | Change | Verdict | Worked | Failed | Next | Record |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(job => `| ${[job.candidate, job.change, job.outcome.verdict, job.outcome.worked,
      job.outcome.failed, job.outcome.next, `${job.taskId}.json`].map(escape).join(" | ")} |`), "",
  ].join("\n"));
}
function emptyJob(store, taskId) {
  const { task, metadata } = ciJobContext(store, taskId);
  return { version: 1, taskId, workspace: task.workspace, branch: metadata.preparation.branch,
    origin: { runner: metadata.runner, preparation: metadata.preparation, handoff: metadata.handoff } };
}
export async function beginCiExperiment(store, taskId, input) {
  return withCiJobLock(store, taskId, async () => {
    if (store.task(taskId).status !== "in_progress") throw new Error("Only the active CI task may select a candidate");
    if (store.isPaused("ci")) throw new Error("CI is paused; candidate selection held");
    const existing = readCiJob(store, taskId);
    if (existing?.outcome && existing.outcome.verdict !== "blocked")
      throw new Error("CI job already settled; do not replace its evidence");
    const candidate = text(input.candidate, "candidate", 96);
    if (!/^[a-z0-9][a-z0-9:/._-]+$/.test(candidate)) throw new Error("CI candidate requires a stable lowercase scope/thesis key");
    const change = text(input.change, "change");
    if (!Number.isFinite(input.acceptance) || input.acceptance <= 0)
      throw new Error("CI acceptance must be fixed before editing as a positive wall-time gain in seconds");
    if (existing) {
      if (existing.acceptance !== undefined &&
          (existing.candidate !== candidate || existing.change !== change || existing.acceptance !== input.acceptance))
        throw new Error("The original CI candidate and acceptance threshold cannot be changed");
      if (existing.outcome?.verdict === "blocked") {
        const { outcome, ...previous } = existing;
        const resumed = { ...previous, candidate, change, acceptance: input.acceptance,
          priorOutcomes: [...(existing.priorOutcomes || []), {
            candidate: existing.candidate, change: existing.change, outcome,
          }] };
        writeJson(ciJobContext(store, taskId).file, resumed);
        refreshCiHistory(store);
        return resumed;
      }
      return existing;
    }
    if (ciJobs(store).some(job => job?.candidate === candidate ||
        job?.priorOutcomes?.some(previous => previous.candidate === candidate)))
      throw new Error(`CI candidate ${candidate} was already attempted; choose a different thesis`);
    const job = { ...emptyJob(store, taskId), candidate, change, acceptance: input.acceptance };
    writeJson(ciJobContext(store, taskId).file, job);
    refreshCiHistory(store);
    return job;
  });
}
const median = values => {
  if (!Array.isArray(values) || values.length < 3 || values.length > 10 ||
      values.some(value => !Number.isFinite(value) || value <= 0)) throw new Error("CI acceptance requires at least three matched positive timing samples");
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
export async function recordCiOutcome(store, taskId, input, { validate } = {}) {
  if (!["accepted", "rejected", "blocked"].includes(input.verdict)) throw new Error("Invalid CI outcome verdict");
  let validation;
  if (input.verdict === "accepted") {
    if (!validate) throw new Error("Accepted CI outcomes require current-head publication validation evidence");
    validation = await validate();
    if (!validation.passed) throw new Error("CI draft validation has not passed for the checked head");
  }
  return withCiJobLock(store, taskId, async () => {
    if (store.task(taskId).status !== "in_progress") throw new Error("Write the CI outcome before finishing the original task");
    let job = readCiJob(store, taskId);
    if (!job && input.verdict === "blocked") job = { ...emptyJob(store, taskId),
      candidate: text(input.candidate, "candidate", 96), change: text(input.change, "change") };
    if (!job) throw new Error("Select and record the CI candidate before editing");
    const outcome = Object.fromEntries(["worked", "failed", "next"].map(field => [field, text(input[field], field)]));
    if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 10)
      throw new Error("CI outcome requires bounded evidence links or paths");
    outcome.evidence = input.evidence.map(value => text(value, "evidence", 500));
    const owner = publicationForTask(store, taskId, { branch: ciJobContext(store, taskId).metadata.preparation.branch });
    const head = owner?.publications?.at(-1)?.head || ciJobContext(store, taskId).metadata.preparation.commit;
    if (input.verdict === "accepted") {
      const metrics = input.metrics;
      if (!metrics || metrics.coveragePreserved !== true || !Number.isFinite(metrics.runnerBefore) ||
          !Number.isFinite(metrics.runnerAfter) || metrics.runnerBefore <= 0 ||
          metrics.runnerAfter <= 0 || metrics.runnerAfter > metrics.runnerBefore ||
          median(metrics.before) - median(metrics.after) < job.acceptance || validation.head !== head) {
        throw new Error("CI acceptance requires the preset measured gain, preserved coverage and no increased runner cost");
      }
      outcome.metrics = metrics;
    }
    const complete = { ...outcome, verdict: input.verdict, head };
    if (job.outcome) {
      const { recordedAt: _recordedAt, ...previous } = job.outcome;
      if (JSON.stringify(previous) !== JSON.stringify(complete)) throw new Error("Settled CI evidence is immutable");
      refreshCiHistory(store);
      return job;
    }
    const result = { ...job, outcome: { ...complete, recordedAt: new Date().toISOString() } };
    writeJson(ciJobContext(store, taskId).file, result);
    refreshCiHistory(store);
    return result;
  });
}
export async function ciRuntimeConfig(store, taskId) {
  const { configure } = await import("./config.mjs");
  const { definition, loadWorkflowConfig } = await import("./workflow-store.mjs");
  const { eventConfiguration } = await import("./workflow-event-config.mjs");
  const runtime = path.join(store.root, ".runner", "automation");
  const input = loadWorkflowConfig(path.join(runtime, "spool-runners.json"), store.root);
  const id = ciJobContext(store, taskId).metadata.runner;
  return configure(eventConfiguration(input, definition(input, id)), "ci", path.join(runtime, "runners", id)).config;
}
export async function runCiCommand(args, options = {}) {
  args = [...args];
  const action = args.shift();
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  if (!["context", "begin", "finish", "validate"].includes(action))
    throw new Error("Use context|begin|finish|validate [--json <file>] [--repeat]");
  const { store, taskId } = ciExecutionContext({ root: option("--spool-root"), taskId: option("--task-id"),
    environment: options.environment });
  const { metadata, contract } = ciJobContext(store, taskId);
  if (action === "context") {
    refreshCiHistory(store);
    const directory = options.evidenceDirectory || "C:\\Agent Logs\\Bohemia-Agent-CI";
    const prior = path.join(directory, "prior-outcomes.md"), job = readCiJob(store, taskId);
    return { workspace: store.task(taskId).workspace, branch: metadata.preparation.branch,
      candidate: job?.candidate, acceptance: job?.acceptance, outcome: job?.outcome,
      history: readFileSync(contract.historyFile, "utf8"),
      priorOutcomes: existsSync(prior) ? readFileSync(prior, "utf8") : null,
      evidenceFile: path.join(directory, `${taskId}.md`),
      templateFile: "C:\\Agent Logs\\Bohemia-Agent-Prompt-Engineer\\agent-ci-template.md" };
  }
  const validate = async () => {
    return queueCiValidation({ store, taskId, config: await ciRuntimeConfig(store, taskId),
      repeat: args.includes("--repeat"), readOnly: action === "finish" });
  };
  if (action === "validate") return validate();
  if (action !== "validate" && !option("--json")) throw new Error("Supply --json with the concise record file");
  const input = readJson(option("--json"));
  if (!input) throw new Error("Supply the concise candidate or outcome JSON file");
  let result;
  const saved = action === "finish" && readCiJob(store, taskId);
  if (saved?.outcome && store.task(taskId).status !== "in_progress") {
    const expected = { verdict: input.verdict,
      ...Object.fromEntries(["worked", "failed", "next"].map(field => [field, text(input[field], field)])),
      evidence: input.evidence?.map(value => text(value, "evidence", 500)),
      ...(input.verdict === "accepted" ? { metrics: input.metrics } : {}) };
    if (!isDeepStrictEqual(expected, Object.fromEntries(Object.keys(expected).map(field => [field, saved.outcome[field]]))))
      throw new Error("Settled CI evidence is immutable");
    result = saved;
  } else {
    result = action === "begin" ? await beginCiExperiment(store, taskId, input)
      : await recordCiOutcome(store, taskId, input, { validate });
  }
  let publication;
  if (action === "finish") {
    if (result.outcome.verdict === "accepted")
      publication = await publishAcceptedCiExperiment({ store, taskId, config: await ciRuntimeConfig(store, taskId) });
    completeCiExecution(store, taskId, result, options);
  }
  return { candidate: result.candidate, change: result.change, acceptance: result.acceptance,
    outcome: result.outcome, ...(publication ? { publication } : {}) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runCiCommand(process.argv.slice(2))));
}
