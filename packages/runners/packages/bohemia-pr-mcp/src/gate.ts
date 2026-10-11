import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type GateOutcome = {
  ok: boolean;
  /// Non-empty only when ok is false. Every line names a cause the caller must fix.
  reasons: string[];
  repoRoot?: string;
  seconds?: number;
  headCommit?: string;
};

/// Candidate clones, most trustworthy first. Harness launches each agent with an absolute
/// CAIRN_HARNESS_DB=<root>/.cairn-harness/harness.db and a server registered with no env block
/// inherits it, but that root is the harness project root, which is NOT where most agents work:
/// the project root is office-bohemia while livesite-agent works in office-bohemia-4,
/// software-engineer-performance in office-bohemia-perf-agent and pr-updater in
/// office-bohemia-pr-updater. The MCP specification says only that the client launches the server
/// as a subprocess and never defines its working directory, so neither signal is authoritative.
/// Both are therefore treated as hints, and the siblings beside them are included so the clone the
/// branch actually lives in can be found. Nothing here decides anything; the branch does.
///
/// Neither hint survives a client that launches the server from the user's home directory: home
/// holds no repository, and its siblings are other user profiles, so the heuristics above return
/// nothing and the gate cannot run at all. The clones also no longer sit beside either hint, having
/// been consolidated one level down into a container directory. A search file therefore names the
/// directories to look in, each treated as a clone if it is one and as a container of clones either
/// way, so discovery can be stated rather than guessed. It only widens the search: the branch still
/// decides which clone is used.
export function searchRoots(environment: NodeJS.ProcessEnv = process.env): string[] {
  const configured = environment.BOHEMIA_PR_MCP_SEARCH_ROOTS?.trim();
  if (configured) return configured.split(";").filter(Boolean);

  const home = environment.USERPROFILE ?? environment.HOME;
  if (!home) return [];
  try {
    const parsed = JSON.parse(readFileSync(join(home, ".bohemia-pr-mcp.json"), "utf8")) as {
      searchRoots?: unknown;
    };
    return Array.isArray(parsed.searchRoots)
      ? parsed.searchRoots.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/// A client may hand the server an extended-length working directory (\\?\C:\...). Node accepts it,
/// so discovery succeeds and the prefix is carried into every path derived from it, but PowerShell
/// resolves such a path to a provider-qualified form whose joins do not exist, so the gate's own
/// Resolve-RepoRoot walked past the clone and threw "Not inside a git repository". The agent that
/// hit that gave up on the tool and published through the raw REST API instead, which is the worst
/// possible failure for a gate: it did not block a bad change, it drove the caller around itself.
/// The prefix is a Win32 API detail with no meaning to git or to the shell, so it is removed at the
/// boundary rather than tolerated downstream.
export function plainPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

export function candidateRepoRoots(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
): string[] {
  const roots: string[] = [];
  const add = (path?: string) => {
    if (!path) return;
    const plain = plainPath(path);
    if (existsSync(join(plain, ".git")) && !roots.includes(plain)) roots.push(plain);
  };

  const database = environment.CAIRN_HARNESS_DB?.trim();
  const fromDatabase = database ? dirname(dirname(resolve(plainPath(database)))) : undefined;
  add(fromDatabase);

  let current = resolve(plainPath(workingDirectory));
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      add(current);
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const hint of [fromDatabase, resolve(plainPath(workingDirectory))]) {
    if (!hint) continue;
    const parent = dirname(hint);
    let entries: string[] = [];
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) add(join(parent, entry));
  }

  for (const root of searchRoots(environment)) {
    const path = resolve(plainPath(root));
    add(path);
    let entries: string[] = [];
    try {
      entries = readdirSync(path);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) add(join(path, entry));
  }
  return roots;
}

/// Kept for callers that only need a starting point. Resolution for the gate goes through
/// candidateRepoRoots, because one root is not enough on a machine with 25 clones.
export function resolveRepoRoot(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
): string | undefined {
  return candidateRepoRoots(environment, workingDirectory)[0];
}

function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string }> {
  // Node refuses to spawn a .cmd or .bat directly on Windows since the CVE-2024-27980 fix, so a
  // batch entry point has to go through the shell or it fails with EINVAL before it ever runs.
  // A shell spawn joins the arguments verbatim, so anything with a space is quoted here.
  const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const shellArgs = viaShell
    ? args.map((argument) => (/[\s"]/.test(argument) ? `"${argument.replace(/"/g, '\\"')}"` : argument))
    : args;
  return new Promise((settle) => {
    const child = spawn(command, shellArgs, { cwd, shell: viaShell });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stdout += chunk));
    child.on("error", (error) => settle({ code: 127, stdout: String(error) }));
    child.on("close", (code) => settle({ code: code ?? 1, stdout }));
  });
}

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await run("git", args, cwd);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed (${result.code}): ${result.stdout}`);
  return result.stdout.trim();
};

/// The branch a clone is on, read from its HEAD file rather than by spawning git. With 25 clones to
/// consider, a process per clone dominates the cost of the scan; a file read does not. Several of
/// these clones are linked worktrees, where `.git` is a file pointing at the real git directory,
/// so that indirection has to be followed or those clones are silently never selected.
function checkedOutBranch(repoRoot: string): string | undefined {
  try {
    const marker = join(repoRoot, ".git");
    const gitDirectory = statSync(marker).isDirectory()
      ? marker
      : readFileSync(marker, "utf8").trim().replace(/^gitdir:\s*/, "");
    const head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : undefined;
  } catch {
    return undefined;
  }
}

/// Picks the clone that actually holds the pull request's branch. Selecting by branch rather than
/// by guess is what makes many clones safe: a gate that ran in the wrong clone would report a
/// confident pass about code nobody is submitting, which is worse than no gate. Being on the
/// branch is not sufficient, because two clones can sit on the same branch at different commits;
/// that happens on this machine today. The pushed tip breaks the tie, and when it cannot, the
/// ambiguity is reported rather than resolved by an arbitrary ordering.
export async function selectClone(
  candidates: string[],
  repository: string,
  sourceBranch: string,
  headCommit?: string,
): Promise<{ repoRoot?: string; reasons: string[] }> {
  const wanted = sourceBranch.replace(/^refs\/heads\//, "");
  const matched = candidates.filter((root) => checkedOutBranch(root) === wanted);

  const onBranch: { root: string; head: string }[] = [];
  for (const candidate of matched) {
    if (!(await git(candidate, "remote")).split(/\r?\n/).includes("origin")) continue;
    const remote = await git(candidate, "remote", "get-url", "origin");
    if (!remote.toLowerCase().includes(repository.toLowerCase())) continue;
    onBranch.push({ root: candidate, head: await git(candidate, "rev-parse", "HEAD") });
  }

  if (!onBranch.length) {
    const inspected = candidates
      .slice(0, 8)
      .map((root) => `${root} is on ${checkedOutBranch(root) ?? "(detached)"}`);
    return {
      reasons: [
        `no ${repository} clone is checked out on ${wanted}, so the required checks could not run against the code being submitted`,
        ...inspected,
        "check out the branch in its clone, then create the pull request again",
      ],
    };
  }
  if (onBranch.length === 1) return { repoRoot: onBranch[0]!.root, reasons: [] };

  const atTip = headCommit ? onBranch.filter((clone) => clone.head === headCommit) : [];
  if (atTip.length === 1) return { repoRoot: atTip[0]!.root, reasons: [] };
  if (new Set(onBranch.map((clone) => clone.head)).size === 1) {
    return { repoRoot: onBranch[0]!.root, reasons: [] };
  }
  return {
    reasons: [
      `${onBranch.length} clones are on ${wanted} at different commits, so the one this pull request was built from cannot be identified`,
      ...onBranch.map((clone) => `${clone.root} at ${clone.head.slice(0, 12)}`),
      headCommit
        ? `the branch on the host is at ${headCommit.slice(0, 12)}; push the clone you built from, then create the pull request again`
        : "push the clone you built from, then create the pull request again",
    ],
  };
}

/// Modified tracked files whose change survives ignoring whitespace, plus anything untracked or
/// staged. Code generators rewrite files like routeTree.gen.ts during a build and Windows line
/// endings leave them flagged as modified while the content is byte-identical, so a plain
/// `git status` reading would refuse over noise the standing prompts forbid agents from discarding.
/// Untracked files are never filtered: a new source file really is work the pull request lacks.
export async function substantiveDirt(repoRoot: string): Promise<string[]> {
  /// Not the trimming git helper: porcelain encodes status in the first two columns, so a leading
  /// space is meaningful and trimming it silently shifts every field by one.
  const entries = (await run("git", ["status", "--porcelain"], repoRoot)).stdout.replace(/\s+$/, "");
  if (!entries) return [];

  const dirty: string[] = [];
  for (const line of entries.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    const file = line.slice(3).trim().replace(/^"|"$/g, "");
    if (status === " M") {
      const diff = await git(repoRoot, "diff", "--ignore-all-space", "--ignore-blank-lines", "--", file);
      if (!diff.trim()) continue;
    }
    dirty.push(`${status.trim() || "M"} ${file}`);
  }
  return dirty;
}

/// Clean local fast-forwards can be checked before publication; behind and diverged clones cannot.
/// After validation, both HEAD and the working tree must still match the commit that was checked.
async function divergence(
  repoRoot: string,
  headCommit: string | undefined,
  when: "before" | "after",
): Promise<string[]> {
  const head = await git(repoRoot, "rev-parse", "HEAD");

  if (headCommit && head !== headCommit && when === "before") {
    const ancestry = await run("git", ["merge-base", "--is-ancestor", headCommit, head], repoRoot);
    if (ancestry.code !== 0) {
      return [
        `${repoRoot} is at ${head.slice(0, 12)} but the branch on the host is at ${headCommit.slice(0, 12)}; checked publication requires a fast-forward`,
        ancestry.code === 1 ? "reconcile the remote branch without discarding unpublished work, then retry"
          : `source ancestry verification failed: ${ancestry.stdout.trim()}`,
      ];
    }
  }
  if (headCommit && head !== headCommit && when === "after") {
    return ["the checkout HEAD changed during validation; refusing to publish an unchecked commit"];
  }

  const dirty = await substantiveDirt(repoRoot);
  if (!dirty.length) return [];

  const files = dirty.slice(0, 8);
  return when === "before"
    ? [
        `${repoRoot} has uncommitted changes, so the checks would have run against code this pull request does not contain`,
        ...files,
        "commit and push them, or discard them, then try again",
      ]
    : [
        "the checks passed but rewrote files in the clone, so the pushed commit does not match what passed",
        ...files,
        "commit and push these changes, then try again",
      ];
}

/// Runs the repository's own gate, which scopes itself to the packages changed since the merge
/// base. The scoping is not reimplemented here, so that a change to what CI runs is picked up
/// without touching this server. It is not identical to CI in one case: when a branch also edits a
/// file that belongs to no package, such as yarn.lock, lage's --since selects the entire workspace,
/// which measured 255 packages and a 6677 second refusal in packages the branch never touched. The
/// gate selects the real packages instead and leaves the workspace sweep to CI, which validates the
/// merge commit anyway.
export async function runGate(options: {
  repository: string;
  sourceBranch: string;
  targetBranch: string;
  headCommit?: string;
  environment?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  repoRoot?: string;
}): Promise<GateOutcome> {
  const candidates = options.repoRoot ? [options.repoRoot] : candidateRepoRoots(options.environment, options.workingDirectory);
  if (!candidates.length) {
    // Whatever this says is what the agent will act on, and an agent told to do something it
    // cannot do (restart its own server elsewhere) will look for another way to publish. So the
    // remedy has to be one the caller can carry out, and the last line has to remove the option
    // that a blocked agent reaches for next.
    return {
      ok: false,
      reasons: [
        "no office-bohemia clone could be located, so the required checks could not run",
        `add its parent directory to searchRoots in ${options.environment?.USERPROFILE ?? "%USERPROFILE%"}\\.bohemia-pr-mcp.json, or set BOHEMIA_PR_MCP_SEARCH_ROOTS, then call this tool again`,
        "do not publish through the REST API or any other route: a pull request opened that way has not been checked",
      ],
    };
  }

  const selection = await selectClone(
    candidates,
    options.repository,
    options.sourceBranch,
    options.headCommit,
  );
  const repoRoot = selection.repoRoot;
  if (!repoRoot) return { ok: false, reasons: selection.reasons };

  const started = Date.now();
  const checkedHead = await git(repoRoot, "rev-parse", "HEAD");
  const stale = await divergence(repoRoot, options.headCommit, "before");
  if (stale.length) return { ok: false, reasons: stale, repoRoot };

  const targetRefName = options.targetBranch.replace(/^refs\/heads\//, "").replace(/^origin\//, "");

  // Fetch the latest target branch ref so merge-base and conflict simulations test against the current remote tip
  const fetched = await run("git", ["fetch", "--no-tags", "origin",
    `+refs/heads/${targetRefName}:refs/remotes/origin/${targetRefName}`, "--quiet"], repoRoot);
  if (fetched.code !== 0) return { ok: false, repoRoot, reasons: [`Target refresh failed: ${fetched.stdout}`] };

  try {
    const { runOperation } = await import("./operations.mjs");
    runOperation("check", { repoRoot, baseBranch: targetRefName });
  } catch (error) {
    return { ok: false, reasons: failureLines(error instanceof Error ? error.message : String(error)),
      repoRoot, seconds: Math.round((Date.now() - started) / 1000) };
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const rewritten = await divergence(repoRoot, checkedHead, "after");
  if (rewritten.length) return { ok: false, reasons: rewritten, repoRoot, seconds };
  return { ok: true, reasons: [], repoRoot, seconds, headCommit: checkedHead };
}

export async function pushPublicationBranch(repoRoot: string, branch: string, targetBranch: string, expectedHead: string): Promise<void> {
  const { runOperation } = await import("./operations.mjs");
  runOperation("push", { repoRoot, branch, baseBranch: targetBranch.replace(/^refs\/heads\//, ""), expectedHead });
}

export async function findRepositoryClone(
  candidates: string[],
  repository: string,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!(await git(candidate, "remote")).split(/\r?\n/).includes("origin")) continue;
    const remote = await git(candidate, "remote", "get-url", "origin");
    if (remote.toLowerCase().includes(repository.toLowerCase())) {
      return candidate;
    }
  }
  return undefined;
}

export async function setupBranch(options: {
  repository: string;
  branch: string;
  baseBranch?: string;
  runSetup?: boolean;
  environment?: NodeJS.ProcessEnv;
  workingDirectory?: string;
}): Promise<{ ok: boolean; repoRoot?: string; branchName: string; reasons: string[]; seconds?: number }> {
  const candidates = candidateRepoRoots(options.environment, options.workingDirectory);
  if (!candidates.length) {
    return {
      ok: false,
      branchName: options.branch,
      reasons: ["no clone found for repository " + options.repository],
    };
  }
  const repoRoot = await findRepositoryClone(candidates, options.repository);
  if (!repoRoot) {
    return {
      ok: false,
      branchName: options.branch,
      reasons: [`no clone matched repository ${options.repository} among candidates: ${candidates.slice(0, 5).join(", ")}`],
    };
  }

  let branchName = options.branch.trim();
  if (!branchName.startsWith("user/") && !branchName.startsWith("users/")) {
    branchName = `user/calebzearing/${branchName}`;
  }

  const base = (options.baseBranch || "master").replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  const started = Date.now();

  try {
    const { runOperation } = await import("./operations.mjs");
    const { gitCredentials } = await import("./git-auth.ts");
    runOperation("prepare", { repoRoot, operation: "branch", mode: "create", branch: branchName, baseBranch: base, runSetup: options.runSetup !== false }, await gitCredentials(repoRoot));
  } catch (error) {
    return { ok: false, repoRoot, branchName, reasons: [error instanceof Error ? error.message : String(error)] };
  }

  return {
    ok: true,
    repoRoot,
    branchName,
    reasons: [],
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

/// The gate already prints only the lines that name a cause, so this keeps its report rather than
/// re-filtering it. Colour escapes are stripped because the transcript is read by a model.
export function failureLines(output: string): string[] {
  const lines = output
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  // The refusal should lead with the cause, so it starts at the gate that failed rather than at
  // the first gate that ran. Passing gates above it say nothing the agent needs.
  const failed = lines.findIndex((line) => /^\s*(FAIL|TIMEOUT)\b/.test(line));
  const start = failed > 0 ? failed - 1 : lines.findIndex((line) => /^==>/.test(line));
  const kept = (start >= 0 ? lines.slice(start) : lines).slice(0, 40);
  return kept.length ? kept : ["the required checks failed but produced no output"];
}
