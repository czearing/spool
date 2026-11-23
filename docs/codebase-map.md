# Codebase map

Use this map to find the owner of a change before editing.

| If you need to change... | Start here |
| --- | --- |
| Desktop composition and navigation | `apps/desktop/src/desktop/app.tsx`, `project-view.tsx`, `page.tsx` |
| Native/browser frontend transport | `apps/desktop/src/platform/request.ts`, `event-source.ts`, `navigation.tsx` |
| Backend request dispatch | `apps/desktop/backend/dispatch.ts`, `route-source.ts`; `apps/desktop/src/app/api/**/route.ts` |
| Desktop page data | `apps/desktop/backend/page.ts`; `apps/desktop/src/desktop/page-data.ts`, `page-query.ts` |
| Shared UI and styling | `apps/desktop/src/components/ui`; `apps/desktop/src/app/*.css`, component CSS Modules |
| Project registry and settings | `apps/desktop/src/lib/projects.ts`, `project-storage.ts`, `settings.ts` |
| Agent instructions and settings | `apps/desktop/src/lib/agents.ts`, `agent-settings.ts`; `crates/spool/src/models/agent_store.rs` |
| Conversation rendering and delivery | `apps/desktop/src/lib/conversation-*`, `spool-conversation.ts`, `task-conversation.ts` |
| Task queues and scheduler admission | `crates/spool/src/queue`; `crates/spool/src/engine/orchestrator.rs`, `operator.rs` |
| Provider sessions and streaming | `crates/spool/src/copilot`; `packages/runners/packages/repository-mcp/src/copilot-autopilot.mjs` |
| Daemon launch and exclusive ownership | `crates/spool/src/engine/background.rs`, `ownership.rs` |
| Shared prompt/workspace resolution | `crates/agent-prompts/src/lib.rs` |
| Native runner supervision | `crates/spool/src/engine/runner_supervisor.rs`; `packages/runners/bridge/native-supervisor.mjs` |
| Independent runner service lifetime | `crates/spool/src/engine/runner_host.rs`, `runner_retry.rs`; `apps/desktop/src-tauri/src/runner_runtime.rs` |
| Indexed, paginated history | `apps/desktop/src/lib/board-read-model.ts`, `agent-jobs.ts`; `apps/desktop/src/hooks/use-agent-jobs.ts` |
| Failure provenance and legacy receipts | `crates/spool/src/engine/task_result.rs`; `packages/runners/bridge/task-failure.mjs` |
| Automation and scanner policy | `packages/runners/bridge`, `packages/runners/scanners` |
| Workflow contracts | `packages/workflow/index.mjs`, `index.d.ts` |
| Application windows, tray, and IPC | `apps/desktop/src-tauri/src` |
| Desktop development HTTP adapter | `apps/desktop/dev/api-plugin.ts`, `http.ts` |
| Runtime packaging | `apps/desktop/scripts/build-backend.mjs`, `build-runners.mjs`, `build-copilot-runtime.mjs` |
| Windows CI, installers, and releases | `.github/workflows/desktop.yml`, `apps/desktop/src-tauri/tauri.conf.json` |

Paths after the first comma are relative to the preceding directory unless a new
root is written explicitly. `src/app/api` is a backend route convention, not a
Next.js dependency.

## Follow a request

For a desktop behavior change, follow the component through `src/platform`, the
backend dispatcher, its API handler, and the owning application library or native
engine command. Keep the native stdio and development HTTP behavior aligned.

For automated work, follow the scanner policy into the runner bridge and then the
native command boundary. Queue admission and provider/session ownership remain in
the engine; a JavaScript caller must not duplicate those state transitions.

## Find the matching tests

| Area | Tests |
| --- | --- |
| Rust engine and session behavior | Tests beside modules in `crates/spool/src` |
| Daemon singleton ownership | `crates/spool/tests/singleton.rs` |
| Prompt resolution | `crates/agent-prompts/src/lib.rs` |
| Application logic and contracts | `apps/desktop/src/**/*.test.ts` |
| Native backend and packaged runners | `apps/desktop/backend/*.test.mjs` |
| Browser adapter and integrated UI | `apps/desktop/dev/*.test.mjs` |
| Components | `apps/desktop/src/**/*.stories.tsx` |
| Runner policies | `packages/runners/bridge/test`, scanner test directories |
| Persistent native adapter | `packages/runners/packages/repository-mcp/test/copilot-autopilot.test.mjs` |
| Windows startup helpers | `tests/install-spool.test.ps1`, `scripts/run-hidden.test.ps1` |

Use the existing fixture in the relevant suite. Fixtures must be isolated from
real projects and must not launch live agents. See
[Contributing](../CONTRIBUTING.md) for commands.
