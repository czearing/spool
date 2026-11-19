# Native conversation continuation

The work item owns the message ledger, transcript and provider-session binding.
Copilot owns the saved model context. Spool never reconstructs that context from
task comments, transcripts or a generated summary.

## Messaging a finished task

With `SPOOL_INTERACTIVE_ACP=1`, native `message` accepts a follow-up on a completed
or failed task that has a saved session and an available workspace. Under the task
lock, it saves the message for that same task. Local tasks return to Incoming;
remote-provider tasks wait for verified workspace preparation before dispatch.
Only the scheduler claims In Progress, respecting session/workspace ownership and
holds. An agent pause blocks new assignments, but permits queued conversation
continuations; task-level pause still stops delivery.
Request IDs are durable and deduplicated. Acceptance is not confirmed delivery.

The provider process may exit between turns or the daemon may restart.
Spool uses `session/load`, checks the returned identity/settings, and sends only
queued new messages. It never replaces a missing session with `session/new`.
Restoration errors preserve the session ID, message and error for inspection.
Unconfirmed interrupted delivery is uncertain, not automatically replayed.

The task pins model, reasoning effort, canonical workspace and the
task-scoped Spool MCP configuration. Changed agent defaults do not change an
existing conversation. Legacy sessions adopt the provider's restored settings.
Explicit handoffs change agent/MCP ownership and enqueue the handoff instruction;
they do not replay the original role or assignment. Recovery with no pending input
adds a short "continue" cue, not a history summary. Uncertain delivery stays paused.
Runner follow-ups use the same native `message` command as chat. Verified runner
workspace migrations may update the workspace binding; ordinary chat messages
cannot move workspaces or change branches.

The daemon advertises `messageContinuationVersion: 1`. The dashboard checks its
fresh heartbeat and this capability before enabling finished-task messaging.
Older/noninteractive daemons remain disabled. Build changes do not activate a
running daemon: deploy only after safely draining active work and provider sessions.

## Prepared runner follow-ups

Runners require the fresh `preparedMessageVersion: 1` capability and interactive
mode. They retain PR detection, preparation and review-result verification, but
never append conversation messages or republish an existing task themselves.
Older and noninteractive daemons fail explicitly instead of using the old writer.

A prepared `message` carries `metadata` containing its submission `key`, original
`sessionId`, `expectedUpdatedAt`, `agent`, prepared `workspace`, and runner
`metadata`. Spool validates the idle terminal task, identity, pending delivery,
prepared checkout, PR contract, acceptance constraints and any explicit migration.
Concurrent chat invalidates a stale preparation instead of being overwritten.

Under the existing task lock, Spool saves the new message and its `runner_metadata`
in the same task update, then performs the normal queue transition. The original
task prompt and title stay unchanged. `spool_get_task`, scheduling and the bridge
read this authoritative metadata before legacy receipt files.

The shared command client journals a deterministic request ID. A small routing
index maps a runner submission key to that native command, without copying task
state or metadata. Only native acceptance is success; pending and accepted retries
reuse that ID and Spool deduplicates delivery. Explicitly rejected preparation can
be corrected with a new request; a possibly committed command is never replaced.
Lost acknowledgements can be recovered without another message. The bridge
derives submission receipts from native command results, not a second metadata
write. Recovery of pre-existing archive journals remains compatibility-only;
new continuations never create those journals.

Runner coverage lives under `packages\runners\bridge\test` in this repository.
Build Spool with `cargo test --locked --no-run --jobs 2` and
`cargo build --locked --jobs 2`. `SPOOL_CONTROL_TEST_BINARY` and
`SPOOL_TEST_BINARY` can override the native test and application executables.
Fixtures use native command handling and isolated fake providers, never production
tasks.

The generic `reserve` command creates a dormant conversation with its original
prompt. It supersedes the legacy `reserve-pr-owner` command. The serialized
`deferred_pr_owner` field remains readable as an alias for `deferred_session`.
Verified prepared continuation is still required before a dormant task starts.

Providers receive `SPOOL_EXECUTION_CONTEXT`, the conversation identity in
`controls\executions`. It intentionally excludes repository-ownership claims;
the legacy `BOHEMIA_CREATOR_CONTEXT` environment variable is removed at launch.
Publication and repository ownership belong to the runner workflow rather than
the native conversation. The retired `spool_register_pr` and `spool_add_comment`
APIs stay disabled, and status changes do not accept embedded comments.
Provider-native task results and the transcript carry current evidence.

## Cache accounting and limits

ACP per-turn usage includes `inputTokens`, `outputTokens`, `cachedReadTokens` and
`cachedWriteTokens`. Spool adds each turn once, and logs the raw usage event.
Cached reads are included in input totals; do not add them a second time.

Same-session restoration preserves context but cannot guarantee a cache hit:
provider eviction, elapsed time and configuration changes can reduce cache reuse.
Spool pins its own launch settings and task MCP declaration, not every user-global
tool, provider setting, hook or repository instruction. Explicit handoff or workspace
migration can also change the provider prefix. Do not promise cache stability across
those transitions.

## Provider lifecycle

ACP keeps one provider for the active work item and consumes queued messages
between turns. Configured idle retention can keep that provider available for
follow-ups, while yielding ownership when another task needs the workspace.
Streaming includes assistant text, tool calls, results and plans, not internal
reasoning. Application runner workers use the separate `runner-supervisor` stdio
protocol and its current-thread runtime.

The persistent task runtime still supports `daemon --detach`, its daemon lease,
and operator capability heartbeat. Runner supervision does not replace that
runtime or change its launch contract. The desktop bridge may autostart the task
daemon independently of application runner workers; `SPOOL_DESKTOP_TASK_RUNTIME`
is a desktop-side setting, not a native runner-supervisor option. Updating the
scheduled-task installer preserves an already-running daemon and its sessions.

A queued message does not interrupt an unfinished local CLI answer. If the CLI records
a completed final answer but holds the prompt request open, Spool requests
cancellation and waits for acknowledgement before sending new input. A missing
acknowledgement fails explicitly after 30 seconds; uncertain input is not replayed.
`messageRecoveryVersion: 1` advertises explicit retry/discard recovery.

Configured ACP providers do not expose live host-local completion history.
Queued input requests a cooperative `session/cancel` for these providers, then
waits for the active prompt's cancellation acknowledgement before sending the
follow-up in the same session. This does not terminate the provider process.
The same 30-second acknowledgement deadline and no-replay rules apply.

Autopilot settings and remote-provider bindings are pinned in the saved session
configuration. A successful native `task_complete` tool result is accepted only
for the current, uninterrupted turn and task owner, with acceptance verification.
Otherwise normal successful execution defaults to completion, still subject to
acceptance verification; it does not imply review approval.

Both launch modes register the task-scoped Spool stdio server through
`--additional-mcp-config`. ACP `session/new` and `session/load` do not carry local
executable declarations: the installed provider rejects non-HTTP/SSE servers
supplied by an ACP client. The command is bound to the current root, agent and
task, including restored sessions. Verify actual tool discovery and persisted
comments/status separately; the cache probe intentionally disables tools.

New sessions are created and used in one process because an empty ACP session may
not yet be persisted. The actual session ID is saved before the first prompt.
Execution context is bound to the immutable provider launch token until a session
environment is available; a mismatched session is rejected. Restored sessions keep
their original identity.

## Historical Paperclip imports

The historical importer attached session bindings to verified PR creators, not
every imported issue. A null task session ID does not prove the original provider
state is gone: Paperclip used a separate `copilotHome`, and some run results omitted
the session ID even though native session files were retained.

Repair only with verified issue/run/agent/workspace provenance and an unambiguous
provider-authored session identity. Restore the original binding and migrate the
native session directory unchanged into Spool's provider home; retain the source
and task backups and verify event-file hashes. Never attach a session based merely
on a similar title, reconstruct history, or overwrite an existing different session.
Use the task mutation lock, preserve queue status and do not dispatch work during
repair. Missing or ambiguous evidence/workspaces leave messaging unavailable.

## Isolated verification

Run from the repository root with an isolated target directory when other Spool
instances are using existing build outputs:

```powershell
$env:CARGO_TARGET_DIR = "$PWD\target-native-validation"
cargo fmt --check
cargo test --locked --jobs 2 -- --test-threads=2
```

Run UI verification from `desktop`:

```powershell
$env:SPOOL_TEST_BINARY="$PWD\..\target-native-validation\debug\spool.exe"
pnpm build
pnpm exec playwright test 'task-chat.spec.ts|task-chat-resume.spec.ts|task-chat-clarity.spec.ts' --workers=2
```

These fixtures use isolated roots and a fake provider. They verify task transitions,
daemon/provider restart, same-session recall, new-input-only payloads, pinned
settings, failed-task continuation, retries and refusal to replace a lost session.
The fake provider reports zero tokens: it is not cache evidence.

Real-provider probes are opt-in tests and consume model tokens. Do not enable them
for ordinary validation or use them against production tasks.
