# Messaging

Storybook: **Components / Messaging**, **Chat input**, and **Message bubble**.
The component demo is deterministic and local. **Tasks / Conversation** previews
the production task dialog; board cards connect that dialog to real Spool history.

## Components

Import directly from `src/components/ui/chat-input`, `message-bubble`,
`message-history`, and `message-thread`.

```tsx
const composer = useRef<ChatInputHandle>(null);

<ChatInput
  ref={composer}
  label="Message"
  onSubmit={async ({ id, markdown }, signal) => {
    await acceptMessage({ id, markdown, signal });
  }}
/>;
```

`acceptMessage` above is the application's transport, not a supplied function.
Resolve only when the message is accepted. Reject with a useful `Error` when it
is not accepted. Generation is a separate operation, not part of this promise.
Use the submission ID as the backend's idempotency key. A UI guard cannot
guarantee exactly-once delivery over a network.

| Component | Contract |
| --- | --- |
| `ChatInput` | Required `label` and asynchronous `onSubmit(submission, signal)`; optional `onStop`, `initialMarkdown`, `disabled`, `placeholder`, `onDraftChange`, `onError`, `className`, `ref` |
| `ChatInputHandle` | `focus()` and synchronous, current `getMarkdown()` |
| `MessageBubble` | Required `author` and `markdown`; optional `direction`, `status`, `error`, `onRetry`, `className` |
| `MessageHistory` | Memoized completed `messages` with unique, stable IDs; keep the array reference stable while a response streams |
| `MessageThread` | Scrollable children with an accessible `label`; optional `empty`; parent must provide a definite height |

`initialMarkdown` is initial content, not a controlled value. Changing it never
overwrites a draft. Mount with a new React `key` to change conversations.
An unmount aborts pending submission and ignores its eventual resolution.
Aborting the UI does not undo a message already accepted by a server.

`onDraftChange` receives Lexical's immutable `EditorState`, without serialization.
Keep this callback stable and do not mirror each keystroke into transcript state.
Draft persistence is intentionally not implemented. A conversation switch discards
the demo draft; a production owner must persist/restore drafts explicitly.

## Draft safety

- Sending reads the current Lexical state, never a debounced Markdown observer.
- Enter and the send button share a synchronous in-flight guard.
- Acceptance clears only the exact, unchanged draft revision that was sent.
- Edits made while awaiting acceptance remain untouched, including after failure.
- Retrying an unchanged failed draft reuses its submission ID. Editing it creates a new submission.
- Successful clearing also clears undo history so Undo cannot resurrect an already sent draft.
- Editor errors are logged, displayed, and disable editing without resetting content.
- Submission and clipboard failures are explicit text feedback.

If a user changes a draft while sending, the entire revised draft is retained:
the component does not guess which prefix the user wants removed.

## Writing contract

Paragraphs, bold, italic, strikethrough, links, inline code, lists, quotes,
and fenced code use Lexical's built-in nodes, history, and Markdown transformers.
No document-editor tables, images, callouts, toggles, slash picker, dragging,
syntax highlighter, mentions, attachment uploads, or collaboration are loaded.

Enter sends consistently, including lists, quotes, and code. Shift+Enter inserts
a newline. Ctrl/Cmd+Enter also sends.
Composition and key-repeat events never submit. Tab retains normal focus navigation.
Formatting shortcuts and Markdown syntax are supported. The Format text control
opens a compact Radix toolbar; formatting preserves the selected range.

The composer starts at 114px: full-width writing area above a persistent action row.
Its shared Toolbar has an unboxed Aa action and standard primary Send button; editor focus strengthens the existing border, with an explicit outline in forced colors.
Long drafts grow to the height cap without moving controls between rows; no resize listeners.
Help lives in tooltips and the formatting popover. During generation, supply
`onStop` to replace Send with Stop in the same position and prevent further sends;
editing remains available. Remove `onStop` when generation ends.

References: `https://www.prompt-kit.com/docs/prompt-input` (writing area/actions) and `https://linear.app/docs/comment-on-issues` (labeled submit).
Slack's official animation (`https://slack.com/help/articles/202288908-Format-your-messages-in-Slack`) shows an inline toolbar toggled from the message field.
Teams' published screenshot (`https://support.microsoft.com/en-us/teams/chat/format-a-message-in-microsoft-teams`) also shows expanded inline tools; our formatting popover is a different interaction, not a copy of either.
Sending feedback lasts until acceptance; an unchanged failed draft shows a retry icon.
Editing that draft restores Send and creates a new identity; retry never means regenerating a response.

Paste uses clipboard plain text and interprets the supported Markdown subset,
not arbitrary clipboard HTML. Code-block paste preserves raw whitespace.
Unsupported Markdown blocks remain readable text. An HTML-only or file-only
clipboard produces an explicit explanation. Unsafe links are unwrapped without
discarding their text, formatting, or selection.

## Rendering and delivery states

`sending`, `accepted`, `generating`, `complete`, `stopped`, and `failed` are
distinct states supplied by the owner. Bubble labels are not individual live
regions: the conversation owner announces acceptance/completion/failure once,
not every streamed token.

Streamdown handles incomplete Markdown. The adapter uses native elements,
CSS Modules, and existing theme tokens instead of Tailwind styles.
Optional code highlighting, diagrams, math, word animations, and built-in controls
are not enabled. Native code/table regions can be reached by keyboard.

Raw HTML processing is disabled; message elements are allowlisted, links use the
shared URL policy, and images become text placeholders without network requests.
Copy copies the original Markdown, including any incomplete streamed syntax.
Copy failure is reported rather than silently claiming success.

The demo streams bounded chunks at 60ms intervals. Production transports should
batch display updates, retain every received character, and flush their final
snapshot before marking completion. Stop preserves the last displayed partial
response; a new accepted demo message stops the previous response rather than
silently running two streams. Demo timers and abort listeners are cleaned up.

## Performance and package decision

Lexical exclusively owns editable DOM and selection. Serialization is explicit;
the only per-edit React signal is whether the draft is empty. Completed history
and the active response are separate state, and completed history is memoized.
The viewport uses size/layout/paint containment so changing the composer does not
force layout through the entire transcript. Scrolling uses `use-stick-to-bottom`
with instant following: users can scroll away, then use Latest messages to return.
No automatic scroll animation or focus stealing occurs during streaming.

A September 29, 2026 standalone production spike compared 80 incremental updates
of an approximately 11 KB Markdown fixture, discarding the first ten samples:

| Renderer | Gzipped JS including React | p50 update | p95 update |
| --- | ---: | ---: | ---: |
| react-markdown 10.1.0 + remark-gfm 4.0.1 | 113,502 bytes | 36.3ms | 43.9ms |
| Streamdown 2.6.0, no optional plugins | 216,365 bytes | 4.4ms | 7.6ms |

These are local comparative measurements, not universal package-size or latency
claims. Streamdown was chosen for update cost despite the extra transfer size.
Only Streamdown ships; the comparison dependencies were removed.
The complete editor/thread fixture is larger than either isolated renderer.
Messaging is dynamically loaded when a board card opens; the board does not eagerly load it.

## Validation and limits

```sh
pnpm exec vitest run src/lib/chat-markdown.test.ts src/lib/editor-markdown.test.ts
pnpm test:messaging --workers 2
pnpm test:messaging:performance
pnpm typecheck
pnpm check:lines
pnpm build-storybook
```

Behavior coverage runs Chromium, Firefox, and WebKit, including keyboard/paste,
late acceptance, retry IDs, conversation replacement, stream stopping, scroll
retention, both themes, accessibility checks, enlarged text, and forced colors.
Synthetic composition coverage is not a replacement for real OS IME/device QA.

The performance command builds a separate production fixture with Vite: it does
not benchmark the Storybook manager or its global highlight observers. It runs
serially without tracing, with 100/500/1,000 messages, a 10,080-character draft,
and simultaneous streaming. The measured keydown-to-after-rAF latency is a frame
delivery proxy, not a physical-display or field INP measurement.

Reference hardware: Windows, Intel Xeon Platinum 8370C at 2.80GHz, headless Chromium.
The unthrottled gate is p95 below 50ms, no main-thread tasks over 50ms during typing,
zero completed-history renders, and zero completed-message DOM mutations.
A run with the revised composer measured p95 15.8/17.5/14.6ms at 100/500/1,000 messages.

The 4x CPU-throttled case is a diagnostic, not the same latency gate. A stress run
at 1,000 messages measured 220-404ms p95 across iterations and long layout tasks despite zero
history renders. The full history remains mounted: low-powered devices and very
large transcripts need a future windowing/pagination decision, with explicit
selection, browser find, accessibility, and scroll-restoration tradeoffs.
There is no claim of unlimited-history performance.

## Spool task conversations

Task cards reuse the shared Radix dialog, messages and Lexical composer. References inspected:
- Linear issue discussions (`https://linear.app/docs/comment-on-issues`): chronological messages with a bottom composer.
- The task dialog deliberately omits task-instruction/log disclosures, activity panels, routine hints and empty-reply placeholders.
- Cursor (`https://cursor.com/help/ai-features/agent`): follow-ups queue while the agent works; show **Queued**, not ambiguous acceptance.
- assistant-ui (`https://www.assistant-ui.com/examples/chatgpt` and its live demo): right-aligned user bubbles, quiet contextual copy controls, bottom composer.
No vendor CSS is copied. The existing neutral tokens, Radix controls and CSS Modules remain.

The server reuses `monitor-data.mjs`, `spool-store.mjs` and `monitor-controls.mjs` from
the existing sibling `spool-runners/bridge` folder. Set `SPOOL_MONITOR_BRIDGE` to an
absolute bridge folder if installed elsewhere; its dependencies must be installed.
No dashboard service or repository preparation runs. Only native `message` requests
are submitted; the editor clears after the daemon's actual acceptance receipt.
Queued is not delivered. Completed/failed tasks resume their saved session when the daemon
advertises `messageContinuationVersion: 1`; only new input is sent. Rejections preserve the draft.

Latest history polls once per second while visible; closing releases the query.
The canonical reader bounds each log window to 256 KiB, with Earlier/Latest navigation.
History navigation appears only when needed. The original request is the opening
message, without agent system instructions; raw terminal logs are not attributed as agent replies.
The composer stays visible; unavailable tasks explain why in its placeholder (or below a saved draft).
Delivery errors remain explicit. Old partial replies never remain marked generating.
Drafts and uncertain message IDs persist per project/task in sessionStorage.
Storage errors are visible; no attachments, reactions, editing sent messages or fake stop controls.
