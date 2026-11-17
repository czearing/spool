---
name: bohemia
description: Use ordinary repository functions for Bohemia preparation, builds and formatted PR descriptions. Repository MCP is retired; validation and Git pushes remain caller-owned.
---

# Bohemia

Use normal repository commands for setup, builds, tests and Git pushes. The optional
functions below reuse the existing implementations without MCP.

| Function | Purpose |
| --- | --- |
| `prepareRepository("bohemia", input)` | Prepare a branch, refresh master, or set up the current checkout. |
| `buildRepository("bohemia", input)` | Run the existing Bohemia build; optionally select `packages`. |
| `checkRepository("bohemia", input)` | Explicitly run the repository's validation gates. |
| `createPullRequest` / `updatePullRequest` | Enforce PR-description formatting only. |

Always pass the explicit absolute `repoRoot` for preparation, build and check.
Paperclip runners prepare agent branches before handoff. If a task says its branch
is prepared, do not prepare/reset it again; edit, build, check and publish.

## Preparation

- Fresh branch: `operation: "branch", mode: "create", branch: "user/calebzearing/topic"`.
- Existing remote branch: `operation: "branch", mode: "checkout", branch: "..."`.
- Continue existing work: `mode: "resume"`. Never combine resume with reset.
- Explicitly discard local changes only in an idle checkout you own: `reset: true`.
  This removes tracked edits and untracked files, not ignored dependencies.
  Never reset another active agent's workspace.
- Refresh master without changing the working branch: `operation: "master"`.
  This fetches the latest remote master; it does not check out master or merge it.
- Merge refreshed master into a working branch: `mergeMaster: true`.
- Review an exact revision: `sourceCommit: "<40-character SHA>"`, a unique review
  branch, `reset: false`, `mergeMaster: false`.
- Set up the existing checkout without changing branches: `operation: "setup"`.

Setup installs dependencies using the checkout's CI installation templates and
warms the existing Bohemia build by default. For build/conflict repair, use
`runBuild: false`: installation must still pass, but the broken build must not
prevent assigning its repair. `allowConflicts: true` leaves a merge's unresolved
paths for a conflict-repair task. An error is not a prepared workspace.

## Build, check and publish

Build and check helpers call the existing implementations. Validation remains
the caller's responsibility and is not a PR publication prerequisite.

Import functions from `repository-mcp`, or run
`node <repository-tools>\src\run.mjs pr bohemia <input.json>`.
Create requires the source branch and all description fields. Update requires
`pullRequestId`; omitted sections are read back and retained. The repository
defaults to `office-bohemia`. Only title/description rules, image upload and
publication readback apply. No checkout or preparation/check receipt is needed.
Push code separately with `git push`. Never post PR comments.

Local animated GIFs are supported in image Markdown and uploaded without
conversion. Prefer cropped before/after GIFs for animations, transitions, or
visible performance changes; static images remain appropriate for static UI.
GIFs supplement, not replace, the measured results table required for perf PRs.

## Automated runners

Import `callBohemia` from `bohemia-pr-mcp/client` for compatibility with existing
runner calls. It invokes ordinary functions, not an MCP transport. Scheduling,
workspace ownership and task lifecycle stay outside PR-description formatting.
