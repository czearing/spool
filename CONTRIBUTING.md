# Contributing to Spool

Small, focused changes are easiest to review. Search existing issues before
starting, describe the problem a change solves, and include a regression test
when behavior changes.

## Set up

Windows is the supported desktop packaging target. Install:

- Node.js 24 and pnpm 11.25.0, matching `.node-version` and `package.json`.
- Rust stable, including rustfmt.
- Visual Studio Build Tools with Desktop development with C++, the Windows SDK,
  and Microsoft Edge WebView2 for Tauri.
- Git. Running real agents also requires GitHub Copilot authentication and access.

From the repository root:

```powershell
pnpm run bootstrap
pnpm dev
```

Bootstrap installs the desktop and runner dependencies from their existing
lockfiles. These are separate dependency roots because runners are packaged as a
self-contained runtime; the root package provides commands, not another copy of
their dependencies.

Quit the installed tray application before starting another native desktop
instance. **Do not stop project daemons or active agents to develop the UI.**
Browser development and Storybook use the installed application's data by
default; use the existing isolated fixtures for automated tests.

## Everyday commands

Run these from the repository root:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Prepare the runtime and start the native desktop app. |
| `pnpm dev:web` | Start the browser development adapter on loopback port 1420. |
| `pnpm storybook` | Develop shared components on port 6006. |
| `pnpm typecheck` | Typecheck the app, backend, and development adapter. |
| `pnpm test:engine` | Test both Rust crates, including interactive conversation fixtures. |
| `pnpm test:runners` | Run the runner regression suite. |
| `pnpm test:ui` | Run frontend and application-logic unit tests. |
| `pnpm test:desktop` | Package the backend and test native stdio integration. |
| `pnpm test:web` | Test browser HTTP, streaming, reload, and UI integration. |
| `pnpm test` | Run engine, runner, and UI unit suites. |
| `pnpm build:web` | Build and typecheck the production frontend. |
| `pnpm build:storybook` | Build the component explorer. |
| `pnpm build` | Build the Windows desktop installer. |
| `pnpm verify:publication` | Check tracked and new source for private state and credentials. |

Install the browser used by integration tests once:

```powershell
pnpm --dir apps\desktop exec playwright install chromium
```

Use focused selectors while iterating, for example:

```powershell
pnpm test:engine copilot::process
pnpm --dir apps\desktop exec vitest run src\lib\projects.test.ts
node --test packages\runners\bridge\test\application.test.mjs
```

The engine test wrapper enables `SPOOL_INTERACTIVE_ACP` only in its test
subprocess. Direct Cargo commands remain available from the root, and build
outputs remain under `target`.

## Change the right layer

Start with [the codebase map](docs/codebase-map.md) and
[architecture](docs/architecture.md).

Keep native process ownership in the Rust engine, scanner policy in runners,
and browser-only HTTP in the development adapter. The native app and development
adapter must continue to use the same backend handlers. Preserve stable IPC,
queue, and workflow contracts, and update consumers together when a contract
must change.

Use the existing CSS Modules, design tokens, and UI primitives. Keep tests near
the behavior they exercise. Add only the tests needed to cover the change and its
meaningful edge cases.

## Before opening a pull request

Explain the problem, the implementation, and the exact validation you ran. Include
screenshots for visible UI changes using synthetic or redacted data. If a check
could not run, state that explicitly.

Run relevant suites, `pnpm typecheck` for TypeScript changes, and
`pnpm verify:publication`. Check Rust formatting with
`cargo fmt --all -- --check` and, for the native shell,
`cargo fmt --manifest-path apps\desktop\src-tauri\Cargo.toml -- --check`.
Do not reset unrelated changes or interrupt another contributor's active work.

Never commit local agents, authentication material, queues, transcripts, project
registries, generated runtime bundles, or dependency directories. Keep third-party
asset license files with the assets.

## Build and release

`pnpm build` prepares the Rust engine, runner runtime, SDK-matched Copilot runtime,
private Node executable, application backend, frontend, and Tauri installer.
The installer is written to
`apps\desktop\src-tauri\target\release\bundle\nsis`.

The [Desktop workflow](.github/workflows/desktop.yml) runs validation and Windows
packaging. Version tags matching the desktop package and Tauri versions publish
installers and SHA-256 checksums to GitHub Releases. Signing secrets are
maintainer-owned; never place them in the repository. See
[desktop development](apps/desktop/README.md) for runtime and signing details.
