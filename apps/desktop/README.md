# Spool desktop

Desktop application sources live in `apps/desktop`. Start with the repository's
[contribution guide](../../CONTRIBUTING.md) for root-level commands and
[architecture](../../docs/architecture.md) for runtime ownership.

The existing React interface, packaged with Vite and a Rust/Tauri Windows shell.
No browser tab, Next.js server, localhost listener, or separately installed Node
runtime is required to run the UI. The installer includes its private runtime.

Runner process supervision runs in the bundled Rust engine: worker startup,
configuration drains, crash retries, event wakes and graceful shutdown have one
native owner. JavaScript retains configuration validation and scanner policies.
The task daemon remains separate; existing agent sessions are not replaced.

## Build

Install Node 24, pnpm (the version in package.json), Rust stable, and the Windows
MSVC build tools. Run `pnpm install --frozen-lockfile`, then `pnpm desktop:build`.
The Windows installer is under `src-tauri\target\release\bundle\nsis`.
`pnpm desktop:dev` starts desktop development. `pnpm storybook` runs the shared
component library without Next.js.

## Local development

Run these commands from `apps\desktop`:

| Command | Use |
| --- | --- |
| `pnpm dev` | Full browser app at `http://127.0.0.1:1420`, with frontend and API source reload. |
| `pnpm desktop:dev` | The same UI in Tauri; quit the installed tray app first. |
| `pnpm storybook` | Shared components at `http://127.0.0.1:6006`, including the same local API adapter. |
| `pnpm test:web` | Isolated HTTP, streaming, origin, and backend reload regressions. |

There is one React application, one route table and one set of backend handlers.
Native IPC and development-only HTTP dispatch to the same backend. Storybook uses
the same Vite configuration; no Next.js app, API proxy, or second server is needed.
Frontend edits reload in place. Browser API edits are loaded on the next request;
native bundled backend edits currently require restarting `pnpm desktop:dev`.

Browser and Storybook development use the installed app's data directory by
default, so mutations affect the same projects. Isolated Vite tests pass an
absolute `spoolDataDirectory` in their server configuration. Native backend tests
use their fixture directory as the backend working directory. Resources come
from `src-tauri\resources` in development and the installed resources in production.
The HTTP adapter accepts only same-origin loopback requests and is excluded from
production builds.

## Local data

Application data belongs in `%APPDATA%\com.czearing.spool`, never in this repo:

- `projects.json`: connected projects, using the existing version-1 registry.
- `desktop.log`: local operation failures and startup diagnostics.

Startup passes application paths directly to the backend. The engine and runner
code always come from the application's resources, and runner configuration and
state always belong to their project. There are no connection-file overrides,
environment-based installation switches, global runner fallbacks, or automatic
legacy installation migrations.

Project folders continue to own their agents, queues, transcripts and settings.
The desktop app neither copies them into its resources nor initializes agents.
Closing the window leaves Spool in the tray; choose Quit Spool to exit the UI.
The separately running task daemon is never stopped by the UI. Runner admission
and supervision also continue after quitting the app or losing its IPC backend.

## History and runner availability

Agent history comes from a disposable SQLite summary index in each project's
`.spool-cache\board-v1.sqlite`. Queue files remain authoritative. The index is
rebuilt after corruption and falls back to memory when the project is read-only.
History is agent-scoped, searchable, and paginated in batches of 60; a selected
older conversation remains accessible without loading the complete history.
List requests do not read transcripts synchronously. New task failures persist
their origin at mutation time; legacy origins are backfilled asynchronously
into `controls\failure-origins`. Process inspection runs separately and can show
an activity warning without hiding saved conversations.

An independent `spool runner-host` process owns the runner service, protected
against duplicates by an OS lock. Windows launch uses job breakaway, falling back
to local WMI process creation when the parent job forbids breakaway. This does
not require an administrator account or a scheduled task. Startup work runs off
the UI path. The IPC backend reconnects after failure without replaying mutations.

The host runs immutable private copies under the application's
`runner-runtimes` directory so installer updates do not replace running binaries
or mix old and new runner modules. A newly opened version publishes its target
in `runner-host-target.json`; the existing service drains its admissions before
handing ownership to the new host. Active task-daemon agent sessions are not
terminated. Older runtime snapshots are retained while they may still be in use.
`runners.log` and `runner-host.json` contain host diagnostics and recovery state.
Crash recovery uses exponential backoff and jitter, an eight-retry budget, and
configuration changes clear blocked worker states. Explicit configuration/auth
exit codes are not retried. Disabling a runner drains it; quitting the UI does not.

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
