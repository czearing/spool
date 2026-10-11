# Spelling feedback quality

Fix the shared engine, not the reviewed prose. Turn the feedback into a small failing regression plus a nearby false-positive case; use parser and language-library evidence, never a phrase-specific replacement.

Run `node --test bridge\test\spelling.test.mjs bridge\test\spelling-publication.test.mjs` from `C:\Code\spool-runners`. Regenerate the current owner's published batch with `node C:\Code\spool-runners\scanners\spelling\repair.mjs --repo <assigned-checkout> --journal C:\Code\spool-runners\runners\spelling\.runner\spelling-publications.json --owner <current-task-id> --output <absolute-artifact-path>`; inspect the report, then repeat with `--apply`. This preserves code and metadata, restores unsafe generated edits to source, and holds ambiguous or incomplete corrections. A changed head or dirty checkout is a blocker, not permission to reset or hand-edit.

Use the existing Bohemia validation and checked publication workflow for the prose diff only. Keep engine changes in spool-runners. Report engine fix, regression, regenerated files, unresolved holds and verified PR head; never call an unresolved language hold fixed or resolve its thread.
