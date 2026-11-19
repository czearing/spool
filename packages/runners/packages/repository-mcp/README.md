# Repository MCP

The MCP validates requests on the host and executes 1JS source operations only
inside explicitly registered Codespaces. Local directories contain connection
configuration, logs and receipts, not source checkouts. Bohemia continues to
forward its original tools, arguments and complete results unchanged.

## Native 1JS commands

| Operation | Command inside the VM | Working directory |
| --- | --- | --- |
| Setup | `yarn fast <selected packages>` | `midgard` |
| Build | `yarn build` | Each selected package |
| Bundle | `yarn bundle` when supported | Each selected package |
| Lint | `yarn lint` | Each selected package |
| Typecheck | Declared typecheck or package-local TypeScript configuration | Each selected package |
| Test | Declared package tests, with Jest/Vitest non-watch arguments where applicable | Each selected package |

The VM's maintained Yarn launcher owns authentication, installation, postinstall,
metadata and native cache behavior. Dependency verification checks installed
tooling; it never launches another installer or upstream build. Missing native
prerequisites fail explicitly. There is no local Scalar/WSL execution, CI-baseline
selection, artifact downloader, seed cloning, private package store, compiler
preload, cache-clearing command or custom CPU/thread throttling.

Preparation retains the existing branch/resume/conflict protections with `main`
as base. `runSetup: false` skips installation; `runBuild: false` never claims a
passing build. The complete surface is `repo_prepare`, `repo_build`, `repo_check`
and `repo_pr`. Every existing 1JS package is selectable directly with `packages`;
build/check/publication can also infer scope from changed files. There is no
Library allowlist, persisted package-admission state or separate application-start tool.
`repo_pr` always runs the selected packages' required checks before publication.

Assigned native sessions use flat arguments: `repo_check({})` infers the repository,
workspace and changed packages. `repo_pr` infers creation unless `pullRequestId`
selects an update; creation uses the current branch unless explicitly supplied.
Explicit package selections and the existing wrapped calls remain supported.
Unbound host callers select `repo` and supply the local control root as `input.repoRoot`. The host
verifies the registered VM, source branch and revision before and after commands.
Wrong roots, redirected source, unsupported commands and failed checks are refused.
Exclusive lifecycle ownership, immutable handoff
evidence and conservative interruption recovery remain enforced.

## Registration

Run `install.ps1 -CodespaceConfigurations <absolute-config-files>` with optional
`-ReviewConfiguration <absolute-review-config>`. Existing Bohemia registration
is not replaced. Engineering VMs and control roots must be distinct from each
other and from the reviewer. See `projects\1js\codespace-*.json`.

The host registration contains only:

```json
{
  "version": 1,
  "codespaceReview": "<absolute reviewer configuration>",
  "codespaceWorkspaces": ["<absolute engineering configuration>"],
  "applicationAuth": {
    "ownerConfig": "<absolute engineering configuration>"
  }
}
```

Unbound host callers select `repo: "1js"`; assigned sessions use the flat calls
above. Native agents use their own source tools
inside the assigned Codespace, not local checkout searches.

## Agent-owned application startup

Application startup stays outside the MCP. Agents use the application's existing
development workflow in their assigned Codespace. `repo_prepare` supports only
`branch`, `master`, and `setup`, matching Bohemia; it never starts or owns an
application server or browser. Build, check and publication do not require an
MCP-owned application lifecycle.

The legacy `applicationAuth` registration field remains accepted for existing
configuration compatibility; it does not enable an MCP application operation.

## Native remote Copilot sessions

The opt-in host launcher `src\codespaces\copilot.mjs --config <registered file>`
runs Copilot ACP inside an engineering Codespace. Copilot's own tools read, search,
edit and execute there; no remote filesystem tool layer is installed. Spool retains
task ownership, same-session continuation and the task-scoped MCP server on the host.
Its per-agent provider configuration selects this launcher without teaching runners
about the remote environment.

The launcher holds the existing workspace lease and maintained authentication
connection for the session. Host repository MCP calls verify and borrow that owner,
so they cannot replace its authentication broker. MCP callbacks use API-key-protected
loopback servers privately reverse-forwarded through SSH. Session identity remains
pinned to the assigned VM and root, and native usage snapshots are imported after
shutdown. Local agents and Bohemia keep their existing execution paths.

Install dependencies through the helper repository's normal npm workspace install.
Live integration tests are explicitly opt-in and use an isolated Spool task; this
does not automatically switch an existing production agent or migrate local sessions.

## Reviewer lifecycle and publication

The reviewer resolves exact PR source, target, comparison base and changed
packages, then delegates checkout, setup and the preparation build to canonical
`repo_prepare`. Azure DevOps pins the comparison base; the owned Codespace
enumerates the complete committed file diff with Git rather than paging through
branch changes over REST. Assignment does not run separate checks, launch an application,
reserve an application port or require browser evidence. The reviewer agent owns
review validation after handoff; preparation does not attest that tests or an
application have passed. The host retains `prepareRepositorySession` and its
authentication/workspace lease through review release; one-shot preparation
cannot own that remote lifecycle.

PR creation/update retains the 1JS template, shared wording validators, admitted
path checks, required package gates, image staging, non-force push, durable
creation intent, duplicate reconciliation and remote readback. It never posts
comments. Existing repository hooks remain enabled. No application code or
maintained 1JS tooling is patched by this adapter.
