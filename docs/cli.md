# CLI and terminal dashboard

The root Cargo workspace still defaults to the `spool` engine binary. These
commands are for a development checkout; the desktop installer does not add its
private engine to `PATH`.

Use the data directory of an existing Spool project for `--root`, not its Git
working repository. The desktop creates the project's queue structure.

## Inspect a project

```powershell
cargo run --release -- --root C:\Spool\my-project status
```

## Open the terminal dashboard

```powershell
cargo run --release -- --root C:\Spool\my-project run
```

The dashboard acquires the project daemon lease. If that project already has a
running daemon, duplicate startup is refused rather than taking ownership from
active agents. Use the desktop or `status` to inspect it instead.

## Submit work

The agent must already exist in the project's `agents` directory:

```powershell
cargo run --release -- --root C:\Spool\my-project submit --agent engineer --title "Review message delivery" --prompt "Find a focused regression test for duplicate delivery." --workspace C:\Code\my-project
```

## Run a headless project daemon

```powershell
cargo run --release -- --root C:\Spool\my-project daemon --detach
```

Do not launch a second daemon over a project with an active owner. The Windows
startup helpers at the repository root are retained for existing installations.

## Run the isolated queue self-test

```powershell
cargo run --release -- test-e2e
```

The self-test creates and cleans up its own temporary directory. It does not use
your live project queues.

Use `cargo run -- --help` for the complete command list.
