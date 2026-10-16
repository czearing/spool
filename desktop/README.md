# Spool desktop

The existing React interface, packaged with Vite and a Rust/Tauri Windows shell.
No browser tab, Next.js server, localhost listener, or separately installed Node
runtime is required to run the UI. The installer includes its private runtime.
It also includes the native Spool CLI used to create, read and update agents;
agent settings do not require a source checkout or a separately installed CLI.

The daemon and runner engines retain their existing implementations, integrated
through a bundled, stdio-only adapter. The native task engine and application
runners are bundled; executing tasks still requires an authenticated Copilot CLI.
The bundled CLI also starts a project's interactive task daemon on the first
send or when opening an existing task conversation. Merely browsing projects or
changing settings does not start task execution.

## Build

Install Node 24, pnpm (the version in package.json), Rust stable, and the Windows
MSVC build tools. Run `pnpm install --frozen-lockfile`, then `pnpm desktop:build`.
The Windows installer is under `src-tauri\target\release\bundle\nsis`.
`pnpm desktop:dev` starts desktop development. `pnpm storybook` runs the shared
component library without Next.js.

## Local development

Run these commands from `desktop`:

| Command | Use |
| --- | --- |
| `pnpm dev` | Full browser app at `http://127.0.0.1:1420`, with frontend and API source reload. |
| `pnpm desktop:dev` | The same UI in Tauri; quit the installed tray app first. |
| `pnpm storybook` | Shared components at `http://127.0.0.1:6006`, including the same local API adapter. |
| `pnpm test:web` | Isolated HTTP, streaming, origin, and backend reload regressions. |
| `pnpm test:installed` | Real installed Windows app: offline project/agent settings, creation, shared imports, previews and restart persistence. |
| `pnpm test:installed:send` | Real installed app and authenticated Copilot: failed-send draft retry, automatic task runtime startup, real responses, continuation and runtime recovery across app restarts. |
| `pnpm test:installed:conversation` | Real installed app: long saved transcripts, cold launches, bounded loading during a stalled backend and recovery with Retry. |

For `test:installed`, quit Spool (including its tray instance) and set
`SPOOL_TEST_APP` to the absolute installed `spool-desktop.exe` path.
The test uses temporary projects and a temporary loopback WebView inspection
port; it does not change your project registry or start task daemons.
Set `SPOOL_TEST_ARTIFACTS` to an absolute directory to retain UI screenshots.
The send test requires an authenticated Copilot CLI discoverable on `PATH`;
it uses the actual provider, not a stub, and consumes model requests. It creates
only temporary projects and acknowledgement tasks, then stops its own daemons.
Conversation page reads have a 15-second deadline covering both response headers
and body. A stalled read displays an error and Retry instead of an endless loading
state; navigation cancellation is not reported as a timeout. The conversation
test briefly suspends only its isolated backend to exercise this failure without
changing saved messages or using a stubbed response.

An interrupted message with unconfirmed delivery is never automatically resent.
The conversation distinguishes that historical uncertainty from a current task
failure and provides **Resend message** and **Leave unsent**, each with confirmation.
Resend warns about possible duplicate work, queues only that message in the same
saved session, and records the earlier message as explicitly retried. Leave
unsent retains the message and its uncertainty without starting work. Decisions
are native, journaled and idempotent; changing a decision after it was applied
is rejected. The running daemon must advertise `messageRecoveryVersion: 1`.
`pnpm test:installed:send` also exercises both confirmation choices and a real
Copilot resend, then republishes the same native command after losing its receipt
to verify that it cannot send twice.
Resolved messages stay at their original timestamps in history, not after the
latest replies. A resolved message older than the loaded page appears only when
that part of history is loaded; unresolved messages remain available for recovery.
Sending with the Send button or Enter immediately jumps to the latest messages,
even when reading older history, without waiting for native acceptance or polling.
The installed send test suspends only its fixture backend to verify this within
two animation frames before any transcript update, then resumes it for a real reply.

The chat view's JavaScript/style loading has its own 15-second deadline, separate
from conversation reads. A stalled or failed view exposes **Retry loading view**
and **Reload app view** instead of leaving an indefinite Suspense placeholder.
Finite native operations also have a 30-second deadline through their response
body; a timeout does not imply that a pending write was rejected or accepted.
Established server-sent event streams are not subject to that finite deadline.

If Copilot records a final answer and its matching turn end but leaves ACP open
for attached background work, queued messages trigger a protocol cancellation.
Spool waits for the cancellation response before continuing in the same provider
session; it neither kills the background work nor replays the original prompt.
Active tools, commentary, subagent answers, and silence do not establish completion.
The history cursor excludes existing records, and timestamp comparisons use the
provider's millisecond precision so fast replies are not mistaken for older turns.
An unacknowledged cancellation fails explicitly after 30 seconds, retaining unsent input.
`pnpm test:installed:queued` verifies two successive continuations with genuine
Copilot replies and live attached processes, without restarting the provider.

The installed conversation test withholds chat stylesheet readiness to exercise
the pre-request loading stage, and suspends its owned backend for both transcript
reads and page navigation.

`pnpm test:installed:saved-conversations` additionally accepts
`SPOOL_TEST_PROJECT_ROOT` and copies settled conversations into an isolated
fixture. It checks their exact transcripts across cold launches and reloads
without sending prompts, and verifies original files remain unchanged.

There is one React application, one route table and one set of backend handlers.
Native IPC and development-only HTTP dispatch to the same backend. Storybook uses
the same Vite configuration; no Next.js app, API proxy, or second server is needed.
Frontend edits reload in place. Browser API edits are loaded on the next request;
native bundled backend edits currently require restarting `pnpm desktop:dev`.

Browser and Storybook development use the installed app's local connection files
by default, so mutations affect the same projects. Set `SPOOL_DATA_DIR` to an
absolute fixture directory before starting either command for isolated testing.
It can contain its own `connections.json` and `projects.json`; no local data is
checked into Git. The HTTP adapter accepts only same-origin loopback requests
and is excluded from production builds.

## Local data

Application data belongs in `%APPDATA%\com.czearing.spool`, never in this repo:

- `projects.json`: connected projects, using the existing version-1 registry.
- `connections.json`: optional absolute paths for `SPOOL_RUNNERS_HOME`,
  `SPOOL_RUNNERS_CONFIG`, `SPOOL_AGENT_BINARY`, `SPOOL_MONITOR_BRIDGE`, and
  `SPOOL_PROJECTS_FILE`. Omit it when only browsing configured project data.
  `SPOOL_AGENT_BINARY` overrides the bundled CLI when explicitly configured.
- `desktop.log`: local operation failures and startup diagnostics.

Project folders continue to own their agents, queues, transcripts and settings.
Shared agents can be imported and previewed while the destination task daemon is
offline. Project model settings and existing agent settings can also be saved
offline; these local configuration changes do not start tasks or alter running
sessions. A fresh destination heartbeat must advertise the requested capability;
incompatible or invalid active runtime capabilities still block changes.
Sending starts the bundled task daemon when that project has no live runtime.
An existing compatible daemon is reused; incompatible daemons are reported,
not stopped or replaced. The native project lease prevents duplicate schedulers.
Startup failures preserve the draft and appear in `desktop.log` and the project's
`logs\task-runtime.stderr.log`. Browser development still uses an independently
started daemon; automatic runtime startup is enabled only by the native adapter.
Project data is never copied into application resources, and the desktop does
not initialize agents automatically.
Closing the window leaves Spool in the tray; choose Quit Spool to exit the UI.
The task daemon (including one started by the desktop) and separately running
runner supervisor are not stopped by the UI. Background task execution survives
quitting or restarting the desktop.
Windows session recovery and process inspection use built-in Windows PowerShell;
installing PowerShell 7 (`pwsh.exe`) separately is not required.

To start the installed app at Windows sign-in, run `scripts\install-startup.ps1`
with `-AppPath` pointing to the installed executable. Run PowerShell elevated if
Task Scheduler denies registration. This replaces only the old web UI login task;
it preserves daemon and runner tasks and never requests or stores a password.

## Releases

GitHub Actions builds Windows installers on source changes and pull requests.
Pushing a matching version tag (for example `v0.2.0`) publishes the successful
installer and SHA-256 checksums to GitHub Releases. Builds are unsigned until a
Windows signing identity is configured; Windows may show a SmartScreen warning.
In-app automatic update installation is not enabled.

Only source, dependency locks and licensed assets belong in releases. Never add
local agents, credentials, queues, project registries, logs, or connection files.
