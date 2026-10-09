# Spool desktop

The existing React interface, packaged with Vite and a Rust/Tauri Windows shell.
No browser tab, Next.js server, localhost listener, or separately installed Node
runtime is required to run the UI. The installer includes its private runtime.

This first migration deliberately leaves the daemon and runner engine unchanged.
Their existing local integrations run through a bundled, stdio-only adapter.
It is not yet a Rust rewrite or a bundled installation of those engines.

## Build

Install Node 24, pnpm (the version in package.json), Rust stable, and the Windows
MSVC build tools. Run `pnpm install --frozen-lockfile`, then `pnpm desktop:build`.
The Windows installer is under `src-tauri\target\release\bundle\nsis`.
`pnpm desktop:dev` starts desktop development. `pnpm storybook` runs the shared
component library without Next.js.

## Local data

Application data belongs in `%APPDATA%\com.czearing.spool`, never in this repo:

- `projects.json`: connected projects, using the existing version-1 registry.
- `connections.json`: optional absolute paths for `SPOOL_RUNNERS_HOME`,
  `SPOOL_RUNNERS_CONFIG`, `SPOOL_AGENT_BINARY`, `SPOOL_MONITOR_BRIDGE`, and
  `SPOOL_PROJECTS_FILE`. Omit it when only browsing configured project data.
- `desktop.log`: local operation failures and startup diagnostics.

Project folders continue to own their agents, queues, transcripts and settings.
The desktop app neither copies them into its resources nor initializes agents.
Closing the window leaves Spool in the tray; choose Quit Spool to exit the UI.
The separately running daemon and runner supervisor are never stopped by the UI.

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
