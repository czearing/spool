# Working on Spool

Read `CONTRIBUTING.md` for commands and `docs/codebase-map.md` for navigation.

## Boundaries

- `apps/desktop`: React/Vite UI, shared application backend, and Tauri shell.
- `crates/spool`: native engine, scheduler, provider sessions, CLI, TUI, and MCP.
- `crates/agent-prompts`: shared role resolution and workspace defaults.
- `packages/runners`: packaged automation policies and repository integrations.
- `packages/workflow`: contracts shared by the desktop and runners.

Keep runtime policy in its existing owner. The development HTTP adapter and
native stdio bridge must use the same backend handlers. Production desktop
builds must not acquire a localhost server dependency.

## Changes and checks

Preserve unrelated changes, running agents, session identities, and workspace
ownership. Do not restart a live daemon to test a source change.
Use isolated fixtures; browser development otherwise shares installed app data.

Update all affected consumers when moving files or changing IPC, queue, or
workflow contracts. Check packaging scripts and `.github/workflows/desktop.yml`
for source-layout changes. Root Cargo commands still build `spool` into `target`;
the Tauri shell intentionally keeps its own workspace and target directory.

Use existing UI primitives, tokens, and CSS Modules. Keep source files small;
the publication guard checks handwritten desktop files against a 200-line limit.
Do not replace working boundaries with extra abstractions merely for symmetry.

Run focused tests, the applicable type/format checks, and
`pnpm verify:publication`. `pnpm test:engine` sets the interactive-test flag in its
subprocess; direct Cargo tests for those fixtures require
`SPOOL_INTERACTIVE_ACP=1`.

Never add local project state, credentials, private prompts, logs, or generated
application resources to Git.
