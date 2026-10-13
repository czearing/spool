import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProseChecker, repositoryWords, scannerVersion } from "./check.mjs";
import { assertProseOnly, planBatches, reviewerRules, roles, validatePlan } from "./plan.mjs";
import { preserveGeneratedRepair } from "./recover.mjs";

const git = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true,
  maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const policy = ".azuredevops/policies/branchpolicies/master/requiredReviewers.yml";
const normalize = text => text.replace(/\r\n/g, "\n");

function assertPublishedCheckout(repo, state) {
  if (git(repo, "branch", "--show-current").trim() !== state.branch ||
      git(repo, "rev-parse", "HEAD").trim() !== state.head || git(repo, "status", "--porcelain").trim()) {
    throw new Error("Regeneration requires the exact clean published branch; newer or authored work is preserved");
  }
}

export async function regenerateBatch({ repo, journal, owner, apply = false }) {
  if (!path.isAbsolute(repo)) throw new Error("Regeneration requires an absolute assigned checkout");
  const matches = Object.values(journal.batches || {}).filter(state => state.ownerId === owner);
  if (journal.version !== 1 || matches.length !== 1) throw new Error("Regeneration requires one exact publication owner");
  const state = matches[0];
  if (state.phase !== "published" || !/^[a-f0-9]{40}$/.test(state.commit || "") ||
      !/^[a-f0-9]{40}$/.test(state.head || "") || !Array.isArray(state.files) || !state.files.length) {
    throw new Error("Regeneration requires a complete published batch receipt");
  }
  assertPublishedCheckout(repo, state);
  git(repo, "merge-base", "--is-ancestor", state.commit, state.head);
  const changed = git(repo, "diff", "--name-only", state.commit, state.head).trim().split("\n").filter(Boolean);
  if (changed.some(file => !state.files.includes(file) && !file.startsWith("change/"))) {
    throw new Error("Published batch contains unrelated files; regeneration held");
  }
  const source = new Map(), published = new Map(), findings = [], reviewFindings = [];
  const rules = reviewerRules(git(repo, "show", `${state.commit}:${policy}`));
  const identities = new Map(rules.flatMap(rule => roles.flatMap(role => rule[role]))
    .map(alias => [alias, { group: true }]));
  const checker = await createProseChecker(repositoryWords(repo, git(repo, "ls-files", "-z").split("\0").filter(Boolean)));
  let plan;
  try {
    for (const file of state.files) {
      if (file.includes("\\") || file.split("/").some(part => part === "..") ||
          !/^(?:packages|apps)\/[^/]+\/.+\.(?:md|[cm]?js|jsx|tsx?)$/i.test(file)) {
        throw new Error("Published batch contains an unsafe regeneration path");
      }
      const before = git(repo, "show", `${state.commit}:${file}`), current = git(repo, "show", `${state.head}:${file}`);
      assertProseOnly(file, before, current);
      source.set(file, before); published.set(file, current);
      const checked = await checker.check(file, before);
      findings.push({ file, issues: checked.issues });
      if (checked.review.length) reviewFindings.push({ file, issues: checked.review });
    }
    plan = await validatePlan(planBatches({ commit: state.commit, findings },
      { rules, identities, read: file => source.get(file) }), checker);
  } finally { await checker.dispose(); }
  const generated = new Map(plan.batches.flatMap(batch => batch.files.map(file => [file.file, file.after])));
  const remainingFiles = state.files.filter(file =>
    normalize(generated.get(file) ?? source.get(file)) !== normalize(source.get(file)));
  const files = [];
  for (const file of state.files) {
    const before = published.get(file), after = generated.get(file) ?? source.get(file);
    assertProseOnly(file, before, after);
    if (normalize(before) !== normalize(after)) files.push({ file, before, after });
  }
  if (apply) {
    assertPublishedCheckout(repo, state);
    for (const file of files) {
      const target = path.join(repo, ...file.file.split("/"));
      if (!lstatSync(target).isFile() || normalize(readFileSync(target, "utf8")) !== normalize(file.before)) {
        throw new Error(`Regeneration source changed: ${file.file}`);
      }
    }
    for (const file of files) {
      const target = path.join(repo, ...file.file.split("/")), current = readFileSync(target, "utf8");
      writeFileSync(target, current.includes("\r\n") ? file.after.replace(/\r?\n/g, "\r\n") : file.after, "utf8");
    }
    git(repo, "diff", "--check");
  }
  return { version: 1, scannerVersion, owner, branch: state.branch, publishedHead: state.head,
    sourceCommit: state.commit, applied: apply, files, remainingFiles, hasChanges: remainingFiles.length > 0,
    held: plan.held, reviewFindings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  for (const name of ["--repo", "--journal", "--owner", "--output"]) {
    if (!args.includes(name) || !value(name) || value(name).startsWith("--")) throw new Error(`${name} is required`);
  }
  if (![value("--repo"), value("--journal"), value("--output")].every(path.isAbsolute)) {
    throw new Error("Repository, journal and output paths must be absolute");
  }
  const relative = path.relative(value("--repo"), value("--output"));
  if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
    throw new Error("Regeneration evidence must be written outside the Bohemia checkout");
  }
  const options = { repo: value("--repo"), owner: value("--owner"),
    journal: JSON.parse(readFileSync(value("--journal"), "utf8")) };
  if (args.includes("--recover")) {
    if (!value("--recover") || !path.isAbsolute(value("--recover"))) throw new Error("--recover requires an absolute receipt path");
    const recovery = preserveGeneratedRepair({ ...options,
      report: JSON.parse(readFileSync(value("--recover"), "utf8")) });
    console.log(JSON.stringify({ recovery }));
  }
  const result = await regenerateBatch({ ...options, apply: args.includes("--apply") });
  writeFileSync(value("--output"), JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({ scannerVersion, applied: result.applied, files: result.files.length,
    hasChanges: result.hasChanges, remainingFiles: result.remainingFiles.length,
    held: result.held.length, output: value("--output") }));
}
