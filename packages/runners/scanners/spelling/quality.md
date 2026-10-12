# Spelling feedback quality

Fix the shared engine, not the reviewed prose. Turn the feedback into a small failing regression plus a nearby false-positive case; use parser and language-library evidence, never a phrase-specific replacement.

Acronym casing requires case-sensitive English dictionary evidence and an uppercase occurrence in parsed prose; declared repository vocabulary remains protected.

Ranked dictionary guesses must not singularize unfamiliar plurals. Spacing repairs are limited to gaps between prose letters, preserving indentation, diagram boundaries and tool directives.

Run `node --test bridge\test\spelling.test.mjs bridge\test\spelling-publication.test.mjs` from `C:\Code\spool-runners`. Regenerate the current owner's published batch with `node C:\Code\spool-runners\scanners\spelling\repair.mjs --repo <assigned-checkout> --journal C:\Code\spool-runners\runners\spelling\.runner\spelling-publications.json --owner <current-task-id> --output <absolute-artifact-path>`; inspect the report, then repeat with `--apply`. This preserves code and metadata, restores unsafe generated edits to source, and holds ambiguous or incomplete corrections. A changed head or dirty checkout is a blocker, not permission to reset or hand-edit.

Use the existing Bohemia validation and checked publication workflow for the prose diff only. Keep engine changes in spool-runners. Report engine fix, regression, regenerated files, unresolved holds and verified PR head; never call an unresolved language hold fixed or resolve its thread.

An operator holding the idle agent/workspace admission lock may pass `--recover <previous-applied-report>` before regeneration. Recovery requires the exact published owner, branch, head and complete generated file contents, rejects staged/untracked/unrelated or subsequent edits, and preserves the output in a named Git stash. It never discards authored work or resets the checkout.

For findings about introduced corruption, distinguish withdrawing the unsafe edit from repairing unrelated baseline prose. Verify each reported defect against the published head and regenerated output; do not treat every held baseline language suggestion as a failed restoration, or claim a remaining defect fixed.
