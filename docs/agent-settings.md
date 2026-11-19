# Agent settings

Agent definitions remain in `agents/<name>.md`. The native MCP exposes
`spool_create_agent`, `spool_get_agent`, `spool_list_agents` and
`spool_update_agent`. The web UI uses these same tools.

Create requires a unique `name` and `prompt`. Optional settings are
`image`, `model` (null inherits the project default), and
`max_concurrent_runs` (a positive integer or null for no agent-wide limit).
New agents default to no uploaded image and one concurrent run.
Settings includes an editable `title` (1 to 120 characters, no control characters).
The title is persisted in frontmatter and shown in navigation and agent headings.
Agents without a title display their existing name. Changing a title never renames
the agent ID or file, moves conversations, or interrupts running work. Omitting
`title` in an MCP update preserves it; stale title edits are revision-checked.
Images are PNG, JPEG or WebP base64 data URLs, at most 64 KiB, persisted in
frontmatter. The UI accepts files up to 5 MB and normalizes them to 256px WebP.
Pass `image: null` to remove an image; omitting it preserves the current image.
Legacy `description` and `icon` metadata remain supported by MCP and are
preserved when omitted; neither has an editing control in the web UI.

Read settings before updating and submit their `revision`, model and run limit.
Concurrent or stale writes are rejected. Creation never replaces an existing
definition; settings updates preserve instructions and unrelated frontmatter.
The prompt editor retains its separate revision-checked editing surface.

Model discovery uses the Copilot runtime bundled with Spool and matched to its SDK,
not the independently updated CLI on the system PATH. Temporary discovery failures
retry automatically and do not block title, image, run-limit, or Autopilot changes.
The current model remains selected, and any previously loaded choices remain visible.
Use **Retry model loading** to refresh choices without discarding unsaved settings.
Selecting a different model still requires server-side catalog validation.

The scheduler discovers new definitions without restart and rereads limits at
admission. Lowering a limit never stops current runs: new work waits until there
is capacity. Increasing or removing a limit admits waiting work automatically.
Workspace and provider-session ownership remain exclusive even with no limit.
Missing or invalid definitions cannot dispatch using a stale cached prompt.

An optional `default_workspace` frontmatter field is an absolute path encoded as
a JSON string. It applies only when a new task has no explicit workspace; existing
sessions never adopt a changed default. Explicit unavailable workspaces fail
without silently falling back to the project data directory. Shared prompt
resolution uses the repository's `packages/agent-prompts` library.

Definitions without a concurrency field preserve legacy behavior: ordinary work
is serialized, while verified independent PR continuations can run concurrently.
Saving an explicit limit applies it to every run, including those continuations.

The daemon advertises `agentSettingsVersion: 1`. The UI refuses writes without a
fresh compatible daemon heartbeat rather than displaying unenforced settings.
