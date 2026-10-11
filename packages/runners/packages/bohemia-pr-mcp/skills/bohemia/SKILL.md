---
name: bohemia
description: Prepare Bohemia workspaces, refresh master, build, check, and create or update pull requests using the shared Bohemia MCP. Use for Bohemia branch checkout, dependency setup, build, validation, or PR publication.
---

# Bohemia

Use these four MCP tools. Do not recreate Git, dependency-install, or build sequences in agent prompts or runner scripts.

| Tool | Purpose |
| --- | --- |
| `bohemia_prepare` | Prepare a branch, refresh master, or set up the current checkout. |
| `bohemia_build` | Run the existing Bohemia build; optionally select `packages`. |
| `bohemia_check` | Run the repository's required validation gates. |
| `bohemia_pr` | Create or update a PR with `action: "create"` or `"update"`. |

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

`bohemia_build` calls the same build implementation as preparation, not another
recipe. The repository owns task dependencies and caching. `bohemia_check` runs
the existing CI-derived validation gates. Fix failures rather than bypassing them.

For `bohemia_pr`, create requires the repository, source branch and all description
fields. Update requires the repository and PR id; omitted sections are read back
and validated. Both actions retain the existing required checks, title/description
rules, image upload and notification behavior. Never post PR comments.

## Automated runners

Import `callBohemia` from `bohemia-pr-mcp/client` and call the same MCP tool with
explicit arguments. It starts the existing MCP transport and waits for a
structured, verified result. Only hand work to Paperclip after successful
preparation and fresh ownership/revision checks. Keep scheduling, ownership,
provenance and Paperclip issue lifecycle outside the Bohemia implementation.
