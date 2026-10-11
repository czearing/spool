# bohemia-pr-mcp

An MCP server that opens and revises Azure DevOps pull requests in
`office-bohemia`. It exists because formatting rules stated in a prompt are not
enforced: compliance is position dependent and decays as constraints accumulate,
so the rules live here as schema and code instead.

## Tools

- `bohemia_prepare` prepares an explicit checkout. `operation` is `branch`,
  `master` (fetch only; preserves the current branch and edits), or `setup`.
  Branch modes are `create`, `checkout`, and non-destructive `resume`.
- `bohemia_build` runs the existing Bohemia build, optionally scoped with `packages`.
  `productionArtifacts: true` requires explicit packages and runs their existing
  `bundle release:brotliCompress` Lage targets with release flavor, under the same
  build lock and capacity checks. It does not upload artifacts or deploy anything.
  Without this option, dependency warm-build behavior is unchanged.
- `bohemia_check` runs the existing repository validation gates.
- `bohemia_pr` creates or updates a PR using `action: "create"` or `"update"`.
  Both retain the existing publication checks, description rules and notifications.
  Updates require `pullRequestId` and must omit `sourceBranch` and `draft`.
  Omit `targetBranch` to preserve the target; an explicit retarget is checked first.

Tests use a disposable home shared with their MCP workers and PowerShell gates.
Fixture telemetry and policy caches never go into the operator's `.bohemia-gate`.

For older machine installations, run `scripts\install-bohemia-compat.ps1 -LegacyRoot <absolute-parent>`.
It replaces the existing legacy CLI and MCP entry points with forwarders to this
shared implementation, including the per-request worker used by already-running
MCP transports. It does not restart workers or edit product checkouts.

PR publication does not accept a free-form description. Sections are separate fields, the
title is assembled from a category enum and a subject of up to six words, and
the wording is checked before anything reaches the network.

Legacy branch/create/update tool names remain callable for already-running clients,
but only the four operations above are advertised. The single usage skill is
`skills/bohemia/SKILL.md`.

## Shared preparation

`src/operations.mjs` owns branch preparation and invokes the existing
`dedicated-runners/repo-gates/bohemia.ps1` setup/build/check implementation.
Installation is derived from the checkout's CI templates by `src/ci-install.mjs`;
the updater no longer owns a separate compilation recipe. Setup and standalone
build share the existing gate's warm-build tasks and repository Lage graph/cache.
The repository gate owns each step's deadline and process-tree cleanup; the
installer and MCP wrapper do not impose competing, shorter deadlines on it.
Git commands retain their transport backstop. Installer process errors precede
Repo consistency runs the checkout's CI commands without injecting Yarn or pnpm as
a launcher. Lockfile validation executes the same CI installer with `--verify`,
which deliberately does not reuse an existing installation stamp. Installer process errors precede
progress output in failure diagnostics. CI-provided `NODE_OPTIONS` take precedence;
otherwise inherited runtime options are preserved before using the default heap limit.

On Windows with pnpm 11 or newer, local preparation explicitly prefers pnpm's
hardlink import path rather than repeatedly copying cached packages into every
fresh checkout. The CI command, frozen-lockfile behavior, integrity verification,
hooks, and build approvals are unchanged. pnpm still owns copying packages that
require builds or patches. An explicit `packageImportMethod` in
`pnpm-workspace.yaml`, a CI command option, or `PNPM_CONFIG_PACKAGE_IMPORT_METHOD`
is respected; set the latter to `copy` to retain the repository's NTFS copy policy.
Yarn, older pnpm, and non-Windows installs retain their existing import policy.

Each CI install step writes a live log under
`~/.bohemia-gate/install-logs` and an atomic running/completed/failed record.
Failures include the last 64 KiB and the full log path, so large install output
cannot exhaust the subprocess capture buffer. MCP progress reports installation
elapsed time and available resolved/reused/downloaded/added counters, not raw
package output. A requested import method is not proof of the actual method:
pnpm may copy where hardlinks are unavailable. Existing MCP transports need a
new connection to display the additional progress; per-request installer workers
load the current installer code independently.

Heartbeats continue every 15 seconds even when diagnostic reads are slow or a PR
call has no checkout argument. Install counters use the last completed diagnostic
read, so they may first appear on the second heartbeat. Transport fixes take effect
on new MCP connections; already-running transports are not restarted.

An installation invalidates its old success receipt before running any steps and
atomically records success only after the steps and root dependency checks pass.
Reuse verifies both executable shims and their package entry files. A failed
reinstallation cannot leave an earlier success receipt authorizing warm reuse.

The commit hook remains authoritative. Copilot's `includeCoAuthoredBy` option
belongs in CLI user settings, not repository-local settings; changing that
user-wide preference requires operator consent and is not a preparation side effect.

Paperclip runners import `callBohemia` from `bohemia-pr-mcp/client`. This is a
stdio MCP client, not another implementation. Both updater lanes, exact-revision
PR review, and generic agent setup use it. Transport workers load current code per
request, so existing MCP server processes need no restart.

Preparation requires an explicit absolute checkout root, refuses dirty work by
default and verifies the requested branch/revision. Destructive cleanup requires
`reset: true` on an idle, owned fresh checkout; resume never resets. Exact-commit
review never merges master. `runBuild: false` lets build/conflict repairs install
dependencies without requiring the broken build to pass.
With `runBuild: false`, verified reusable pnpm dependencies need only the checkout lock, not a machine build slot; stale or incomplete installations still use normal preparation.

Branch preparation explicitly refreshes the target remote-tracking ref and
requires a merge base before setup and handoff. This also applies to resumed PRs
and independent clones whose fetch configuration only names the task branch.
When the checked-out branch is the target, its existing fetch also satisfies this
refresh; preparation does not fetch the same target a second time.
Publication refreshes the target with an explicit refspec rather than relying
on that fetch configuration. Neither refresh merges or switches the task branch.

The checkout's Git directory contains `bohemia-preparation.json` with stage and
failure evidence and an exclusive preparation lock. Caller-owned Paperclip
admission checks remain outside MCP. Preparation does not decide PR ownership,
invent originating tasks, or reassign human-owned work.

## Required checks

Both tools run the repository's required checks before writing anything, and
refuse with the failing output when they do not pass. There is no override.
Create and update validate clean local commits that fast-forward the remote source,
perform a non-force push through the shared check operation when needed, and read
the exact remote commit back before writing the PR. Behind or diverged sources,
HEAD changes during validation, failed pushes and branch-lookup errors refuse publication.
The gate refreshes the target before validation; cached passes bind the source,
target revision and validation implementation, not just their merge base.
Receipts expire after 30 minutes using UTC-aware timestamps; future timestamps
are not reusable. Gate subprocess output is drained before recording a verdict.
Pipes still open after a bounded five-second drain cause explicit failure, never
a passing result with missing diagnostics.
An explicit Azure DevOps `400 / GitPullRequestCannotBeActivated` rejection is retained
as rejection evidence and allows a reconciled retry of the same creation intent.
Spool creator identity does not require a launch-time workspace or branch.
When absent, the publication gate selects and verifies the actual checkout and the
PR receipt records it without migrating the task or conversation. Supplied checkout
and branch constraints, creator/session verification and retry protection still apply.
Transport errors, unrecognized responses and lost acknowledgements remain uncertain:
they never authorize another POST without finding the original PR.
Because the gate runs first, a rejected branch leaves no pull request behind to
abandon and a rejected revision leaves the existing one untouched.

For Spool proof-backed bundle work, both create and update also resolve the
original `bundle-v2` task contract by branch, regardless of the requested category.
Before PR writes, the shared performance validator runs the canonical production
build and independent browser matrix, or revalidates exact saved evidence. Missing
contracts, dirty/stale source, different artifacts and incomplete browser evidence
refuse publication. Remote readback then binds the checked commit and original
creation marker to a bundle-delivery receipt required by native task completion.
Legacy tasks without a bundle contract retain the normal gates. Root discovery
uses `SPOOL_ROOT`, a native creator context, or the bundled runner configuration;
no personal checkout path is embedded in this gate.

`bohemia_pr_update` used to skip them, on the reasoning that it only rewrites
text and that charging a gate run for a wording fix invites people to route
around it. That was wrong on the more important axis. A gate is only as strong
as its weakest path, so exempting one write path does not save time, it decides
which path a change takes to reach Azure DevOps unchecked, while the tooling
still reports itself as enforcing. Revising a pull request here means revising
the change behind it. The cost is small when nothing moved, because Lage replays
a cached result for an unchanged tree. `every write path is gated` in
`enforcement.test.ts` asserts both the presence and the ordering of that call, so
removing it fails a test rather than a pull request months later.

### The checks come from the pipeline, not from a copy of it

The checks are not reimplemented here. Publication calls the same `runOperation`
check implementation and bundled PowerShell gate as `bohemia_check`; no separately
installed `bohemia.cmd` or fixed machine path is required. That gate reads
`azure/build-pipelines/code-format-validation.yaml` and
`templates/jobs/build-unit-tests.yaml` at run time to discover what to run.

It used to carry a transcribed target list instead, which is a promise a script
cannot keep: the pipeline is edited by people who have never heard of this gate,
nothing fails when the two diverge, and the divergence stays invisible until a
required build fails on a real pull request. That is exactly what happened. The
copy omitted `knip`, a branch passed here, and the required build failed on an
unused dependency the branch had just added to its own package.

So the gate now takes the Lage targets from every pipeline step scoped with
`since:`, and subtracts only the three that cannot mean anything outside a build:
`uploadEslintResults` and `uploadTestCoverage` publish results against a build
id, and `test:compat` downloads artifacts from one. That subtraction list is
small, stable and justifiable; the target list is neither, which is why one is
written down and the other is read. If the pipeline cannot be read, the gate
refuses rather than falling back to a stale literal, since a silent fallback
reintroduces the drift being removed.

The same applies to the repo-level steps that run before the Lage step. Those
were never copied at all, and they were the larger gap: `yarn dedup --list
--fail`, `validate:lockfile`, `rumdl:check`, `package-json-formatter:check`,
`major-lock:check` and `docs:generate-toc` all block the required build, and a
`yarn.lock` branch could fail the first of them with no local warning. They are
read from the same file. Steps that genuinely cannot run on a Windows agent, or
that need pipeline variables, are named at the top of every run with the reason,
so a step added to CI surfaces as a reported gap instead of silently never
running.

Scoping is copied from the pipelines rather than invented: both `pr-build.yaml`
and `code-format-validation.yaml` scope with
`git merge-base origin/$(System.PullRequest.targetBranchName) HEAD`. Only the
packages the branch actually touched are checked, so cost tracks the size of the
change.

### Commit messages

The gate refuses a branch whose commits credit an AI tool as an author, naming
each commit and the offending line. It runs before the lock and before any
expensive work, so it costs seconds rather than a full gate run.

This lives here because it cannot live anywhere else. The Copilot CLI appends
`Co-authored-by: Copilot` and `Copilot-Session:` to the commits it makes, and as
of August 2026 there is no supported way to turn that off for the CLI; the
setting people cite no longer works, and the documented switch exists only in the
VS Code extension. A standing instruction not to credit AI tools was therefore
competing with the harness's own commit construction, and losing.

A git hook is not enforcement either: hooks are not cloned, every clone has to
opt in, and `--no-verify` skips them. `bohemia setup` installs a `commit-msg`
hook anyway, because catching this at commit time costs seconds while catching it
at publish time costs a history rewrite. The hook uses only shell built-ins,
since git's bundled `grep` is not reliably on a hook's PATH on Windows and a hook
that fails to run looks like a pass. It never overwrites a hook it did not write.

### When a branch also edits a repo-level file

Cost tracks the size of the change with one exception. A changed file that
belongs to no package, `yarn.lock` being the usual one, makes `--since` select
every package in the workspace. A four file branch selected 255 packages that
way and was refused after 6677s on Windows-only failures in packages it never
touched. `--ignore` does not help: measured on lage 2.15.17, ignoring all four
changed files still selected 255, while `--since HEAD` correctly selected none,
so the flag is inert. The gate selects the genuinely changed packages with
`--scope` instead, which includes their dependencies and dependents, and leaves
the workspace sweep to CI, which validates the merge commit anyway. What that
gives up locally is a dependency bump that breaks a package the branch does not
otherwise touch; that now surfaces in CI rather than two hours later here. The
same branch went from 6677s and refused to 1128s and passed. `-Full` forces the
workspace sweep back on for the case where CI disagrees with a local pass.

The repo-level checks are narrowed the same way, by input rather than by
package. Nine of them run on every branch under `concurrently`, and two set the
whole cost: `syncpack:check` at 153s and `docs:generate-toc` at 139s, against 1
to 26s for the rest. Neither can be affected by a branch that edits no
`package.json` and no `docs/` file, so a declared input set decides which ones a
change can possibly break. The declarations are deliberately loose, because the
two errors are not symmetric: over-declaring costs a check that was going to
pass, while under-declaring reports a pass that was never established. A command
the map does not know is always run, so adding a check to the pipeline cannot
silently skip it here. Measured on one real branch, the same commit and the same
verdict: 408s to 106s, with the repo-level portion falling from 314s to 26s.

Two further limits stop a run from disappearing. Gates take a mutex per clone
and a machine-wide slot per eight cores, because five concurrent runs, two of
them in one worktree sharing a `node_modules` and a lage cache, stretched a 34s
step to 568s. The lock is held only around the expensive work, so a run that
fails on bookkeeping never occupies a slot. Each gate also has a timeout and
reports the limit it hit, rather than looking like a hang.

The gate needs the clone that actually holds the branch, and that is not where
the server happens to be running. The Harness project root is one clone;
the agents work in others beside it, so resolving a single root checks the wrong
tree for most callers. The server instead enumerates candidates, the Harness
root, the walk up from its working directory and every sibling clone, and
selects among them: `origin` must be this repository and the checked out branch
must be the pull request's own source branch.

Branch alone does not identify a working tree. Two clones can sit on the same
branch at different commits, so when more than one matches, the tie is broken by
the branch tip Azure DevOps already has. If that still does not resolve to one
tree the tool refuses and names every clone it inspected, because checking the
wrong tree passes a gate the pushed code never faced. Several of these clones
are linked worktrees whose `.git` is a file rather than a directory, so branch
reading follows that indirection.

Finding the right clone is not enough, because the checks run against a working
tree while the pull request is built from the pushed commit. Those two came
apart on a real pull request twice over, once with an uncommitted change on disk
and once with the clone four commits behind its own branch, and both times the
gate passed code nobody was submitting. So the tool refuses unless local `HEAD`
is the branch tip Azure DevOps holds and the tree carries no substantive change,
naming both commits so the disagreement can be settled.

The tree is compared again after the checks pass. The repository's prettier
worker rewrites the file it is only meant to be checking, which makes the
failure self-concealing: the first run fails and quietly fixes the file, and the
next run passes while the pushed commit is still unformatted. End-of-line churn
in generated files is exempt, since it is not work the branch is missing and the
standing prompts forbid agents from discarding it.

## What the tool owns, and what the agent owns

The tool owns the shape: the three committed headings, the title prefix, the
sentence limits and the wording rules. The prompt asks for concise, direct
descriptions containing only essential reviewer information: the problem, the
change, and relevant verification. Omit task history, implementation walkthroughs,
and repeated validation. Tables belong only to relevant measured before/after
performance comparisons, not summaries, checklists, or build status. The agent
writes compact evidence tables in `solution` using columns suited to the measurements.

The rules survive that freedom. Sentence counting, file paths, line numbers,
task ids and dates are checked against the prose alone, so a cell reading
`ms/frame` is not mistaken for a path and a row ending in a full stop is not
mistaken for a sentence. Em dashes, hype and crediting an AI tool are checked
across tables and captions too, and never inside a code fence.

A `perf` change must contain a table. A change marked `uiChange` must contain
images. Local image paths in the markdown are uploaded to the pull request and
rewritten to hosted URLs; already hosted images are left alone, so revising a
sentence does not orphan a second copy of every attachment.

`bohemia_pr_update` splits the stored description on its headings and keeps each
section verbatim, so revising one sentence preserves the tables and images
beneath it byte for byte.

`targetBranch` is optional and resolves to the repository's own default branch
rather than a literal, because guessing `main` here would have targeted a ref
`office-bohemia` does not have and broken the gate's merge-base scoping.

Both tools close by naming what this particular change now has to retest: the
benchmarks for a `perf` change, the screenshots for a visible one, its tests
otherwise. Standing prompts used to carry every case at all times; saying only
the applicable one, at the moment it applies, replaced 303 characters of prompt
with a sentence that is never wrong for the change in hand.

## Why the server holds no rules

A session spawns this server once and keeps it for hours, and a process serves
the code it loaded at startup. That is how a pull request was updated with the
checks skipped a full day after the gating landed: `tools.ts` was fixed on disk
at 15:46, fifteen servers were already running, and the agent that called
`bohemia_pr_update` the next evening was executing the old copy.

So `index.ts` is the transport and nothing else. It imports nothing from the
rule graph, and answers `tools/list` and `tools/call` from a process started for
that request (`worker.ts`). An edit to a rule is therefore in force everywhere
the moment it is saved, with no restart and no way to tell which servers are
old. A cache-busting `import()` would not do: it re-evaluates the one file, but
that file's own imports still resolve from cache, so the rules would stay stale
behind a mechanism that looks deliberate. Spawning costs about 0.1s against
check runs of minutes.

`enforcement.test.ts`
fails if `index.ts` ever gains a relative import, spawns nothing, or grows a
timeout.

## Identity

The Discord sender is never an argument. Harness launches each agent with
`CAIRN_HARNESS_AGENT=<worker id>` and this server inherits it. Without that
variable the caller is Caleb rather than an agent, so the pull request is still
created and only the Discord message is skipped.

## Wiring

Register the server once in `~/.copilot/mcp-config.json`, with no `env` block so
`CAIRN_HARNESS_AGENT` is inherited. Harness copies that file, along with
`config.json`, `settings.json` and `permissions-config.json`, into each agent's
own profile at `<repo>/.cairn-harness/copilot-home/<agent>/` every time the
agent launches (`acp_profile.rs`, `sync_from`). The per-agent copies are
therefore derived, not authored: a newly registered server reaches every agent
on its next launch, and a profile that predates the change is stale rather than
misconfigured.

## Configuration

| Variable | Default |
| --- | --- |
| `BOHEMIA_ADO_ORG` | `https://office.visualstudio.com` |
| `BOHEMIA_ADO_PROJECT` | `OC` |
| `BOHEMIA_PR_DISCORD_ENV` | `C:\Code\discord-mcp\.env` |

Authentication uses `az account get-access-token`, so `az login` must be current.
Sign-in redirects and HTML authentication responses are reported as authentication
failures, not JSON parsing errors. The publisher does not follow redirects or replay
writes after these failures; restore account access and reconcile the original intent.
Descriptions are sent as JSON to the REST API because `az repos pr --description`
collapses multi-line markdown while still reporting success.

A call lasts as long as the checks do, which is minutes. A client that hears
nothing that long abandons the request with `-32001` while the checks keep
running, and the agent reads that as a broken tool and looks for another way to
publish. Two things prevent it, and both are needed: the `bohemia-pr` entry in
`mcp-config.json` carries a `timeout` in milliseconds, and the server sends
`notifications/progress` every fifteen seconds while a call is in flight, which
resets the client's timer and shows the caller the work is alive. Progress is
sent only when the caller supplied a token to correlate it with.

## Checks

```
bun test                    # format enforcement, rendering, identity, schemas
```

The live probe drives the real server over stdio against the real repository. It
pairs every draft that must publish with a near-identical one that must not, and
abandons the pull request and deletes the scratch branches when it finishes.

It also exercises the gate for real. It works in an idle clone, commits a
deliberate formatting and lint violation, and asserts that the pull request is
refused, that the refusal names the offending file, and that no pull request was
created; it then reverts the violation and asserts the same draft publishes. The
violation is pushed before the gate is asked to judge it, because an unpushed
commit is now refused on its own, which the probe asserts first. The clone is
restored to the branch and the clean tree it was found on, and that restoration
is itself asserted.

Run it after changing `render.ts`, `validate.ts`, `gate.ts` or `ado.ts`. It
caught a parser bug that the unit tests could not.
