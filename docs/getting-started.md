# Get started with Spool

## Install

Download the Windows x64 installer from
[the latest release](https://github.com/czearing/spool/releases/latest).
Release assets include SHA-256 checksums. Installers are currently unsigned;
Windows may display a SmartScreen warning.

The desktop installer includes its Node runtime, Rust engine, automation workers,
and SDK-matched Copilot runtime. You do not need a development checkout to use it.
Agent execution requires an authenticated GitHub Copilot account with access to
the selected model and the repositories you intend to change.

## Add a project

Open Spool, choose **Add project**, and give it a name. A project's data directory
is not an agent's working repository: each agent can have its own workspace.

New projects keep their data in the configured project storage location.
Existing projects stay in their original folders. Connecting a project does not
copy its queues or transcripts into the application's installation directory.

## Add an agent

Create an agent, give it focused instructions, and select its model and run
limit. Configure its workspace before asking it to work in a repository.
Instructions are stored in the project's `agents\<name>.md` file; settings changes
preserve the instruction body. To set a default checkout, add this field to that
file's existing frontmatter, keeping its other fields:

```yaml
default_workspace: "C:\\Code\\my-project"
```

The folder must already exist. An explicit task workspace takes precedence.

An agent's run limit controls admission, not termination. Lowering a limit never
stops already-running work. Workspaces and provider sessions remain exclusively
owned even when an agent permits multiple runs.

See [agent settings](agent-settings.md) for shared instructions, model discovery,
workspace defaults, and the native MCP interface.

## Start a conversation

Select an agent and send a message. The conversation shows assistant replies and
tool activity; task views expose queue state and logs. Follow-up messages remain
bound to the saved provider session rather than reconstructing context from old
transcripts.

An accepted message is not necessarily delivered yet. Work may wait for an
occupied agent slot, workspace preparation, or a paused task. Inspect its state
and reported error instead of sending duplicate requests.

## Know what keeps running

Closing the window leaves Spool in the tray. **Quit Spool** exits the desktop
application, but project task daemons have a separate lifetime and active agent
sessions are preserved.

Do not stop an active daemon to apply an update. A running process does not load a
replacement engine merely because its file changed; update it only after its work
has safely finished.

## Inspect local state

Application settings and connected-project records live in
`%APPDATA%\com.czearing.spool`. Project directories own:

```text
agents\                 Agent definitions and instructions
queues\incoming\        Work waiting for admission
queues\in_progress\     Claimed tasks
queues\completed\       Completed tasks
queues\failed\          Failed tasks
controls\               Requests, session bindings, and runtime controls
logs\                   Task transcripts
usage\                  Usage accounting
```

These are private working files, not contribution artifacts. Redact credentials,
prompts, paths, and repository content before sharing diagnostics.
