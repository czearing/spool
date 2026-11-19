---
name: repository-workflow
description: Prepare, build, check and publish 1JS changes through the shared repository MCP, with transparent access to the existing Bohemia MCP.
---

# Repository workflow

Use the four operations: `repo_prepare`, `repo_build`, `repo_check`, and `repo_pr`.
In an assigned native session, pass operation arguments directly. The MCP already
knows the repository and workspace; `repo_check({})` infers changed packages.
Explicit `packages` selections are supported across the repository, not just
Library. Do not invent checkout paths, package restrictions or build recipes.

An unbound host caller supplies `{ repo: "1js", input: { ... } }` with the
registered local control root as `input.repoRoot`. Existing wrapped calls remain
supported in assigned sessions.

- If the runner prepared the branch, continue it without preparing or resetting
  the workspace again. Never reset another agent's workspace.
- Build and check use the selected packages' existing commands. Fix failed gates;
  do not bypass hooks or publish through another route.
- `repo_pr` defaults to creation on the current branch. Supplying `pullRequestId`
  defaults to updating that PR. Supply the description and evidence required by
  the tool schema. Omitted update sections are read back and validated.
- PR creation and update retain required checks, title/prose validation, evidence,
  non-force push, duplicate protection and remote readback. Never post PR comments.
- On failure, read the original error and its `Next` action. For an uncertain
  publication result, inspect the recorded operation and existing branch PR before
  retrying; do not blindly create another PR.

Native source work stays inside the assigned Codespace. Workspace ownership and
authentication remain enforced by the host. The MCP does not add an application
startup operation; use the application's existing development workflow.

Bohemia retains its existing `bohemia` skill and tools. The unbound
`repo: "bohemia"` route forwards `input` unchanged.
