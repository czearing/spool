import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { readJson, samePath, writeJson } from "./spool-store.mjs";
import { checkRepository, scannerVersion, writeReport } from "../scanners/spelling/check.mjs";
import { assertNativeSupport, createSpellingPublisher, publicationVersion } from "../scanners/spelling/publish.mjs";

export function createSpellingScan({ store, config, workspace, runtime, call,
  check = checkRepository, report = writeReport, observe = () => {}, now = () => new Date(),
  publish = config.publishAgent && createSpellingPublisher({ store, config, runtime, call }),
  support = assertNativeSupport }) {
  const stateFile = path.join(runtime, "state.json");
  return async () => {
    const timestamp = now(), state = readJson(stateFile);
    if (config.publishAgent) support(store);
    if (state?.lastReportedAt && state.scannerVersion === scannerVersion) {
      const last = Date.parse(state.lastReportedAt);
      if (!Number.isFinite(last)) throw new Error("Invalid Spelling report schedule");
      if (timestamp.getTime() - last < config.pollSeconds * 1000 &&
          (!publish || state.publicationVersion === publicationVersion && !state.publicationPending) &&
          [state.markdown, state.html, state.json].every(file => typeof file === "string" && existsSync(file))) {
        return { dispatched: 0, filesWithIssues: state.filesWithIssues, issues: state.issues,
          report: state.html, nextScan: new Date(last + config.pollSeconds * 1000).toISOString() };
      }
      if (publish && state?.publicationPending && state.scannerVersion === scannerVersion &&
          existsSync(state.json)) {
        const result = readJson(state.json);
        const published = await publish(result);
        writeJson(stateFile, { ...state, publicationPending: false, publicationVersion, publication: published });
        return { dispatched: 0, report: state.html, ...published };
      }
    }
    const active = store.tasks().filter(task => ["incoming", "in_progress"].includes(task.status));
    const live = store.liveTasks();
    if ([...active, ...live].some(task => samePath(task.workspace, workspace))) {
      throw new Error("Spelling scan checkout is owned by an active task; refresh refused");
    }
    const holds = path.join(store.root, "controls", "workspace-holds");
    if (existsSync(holds)) {
      for (const name of readdirSync(holds).filter(name => name.endsWith(".json"))) {
        const hold = readJson(path.join(holds, name));
        if (!hold || typeof hold.workspace !== "string") throw new Error("Invalid workspace reservation");
        if (samePath(hold.workspace, workspace)) throw new Error("Spelling scan checkout is reserved; refresh refused");
      }
    }
    const prepared = await call("bohemia_prepare", { repoRoot: workspace, operation: "branch",
      branch: "master", baseBranch: "master", mode: "checkout", reset: false, runSetup: false, runBuild: false });
    if (!prepared?.ready || !samePath(prepared.repoRoot, workspace) || prepared.branch !== "master" ||
        !/^[a-f0-9]{40}$/i.test(prepared.commit || "")) throw new Error("Spelling repository refresh was not verified");
    const result = await check(workspace, { observe, previousReport: path.join(runtime, "spelling-todo.json") });
    const files = report(runtime, result);
    const completedAt = now().toISOString();
    const saved = { version: 3, scannerVersion, lastReportedAt: completedAt, commit: result.commit,
      publicationPending: Boolean(publish),
      filesWithIssues: result.filesWithIssues, issues: result.issues, ...files };
    writeJson(stateFile, saved);
    const published = publish && await publish(result);
    if (published) writeJson(stateFile, { ...saved, publicationPending: false, publicationVersion, publication: published });
    return { dispatched: 0, filesWithIssues: result.filesWithIssues, issues: result.issues,
      ...(published || {}),
      filesScanned: result.filesScanned, report: files.html,
      nextScan: new Date(Date.parse(completedAt) + config.pollSeconds * 1000).toISOString() };
  };
}
