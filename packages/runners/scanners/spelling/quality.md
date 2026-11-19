# Spelling feedback quality

Fix the shared engine, not the reviewed prose. Turn the feedback into a small failing regression plus a nearby false-positive case; use parser and language-library evidence, never a phrase-specific replacement.

Acronym casing requires case-sensitive English dictionary evidence and an uppercase occurrence in parsed prose; declared repository vocabulary remains protected.

Unsupported uppercase counterparts remain explicit review findings so publication cannot leave partially capitalized pairs on an edited line.

Ranked deletions require a repeated-letter typo; other deletions and suggestions lacking case-sensitive English recognition remain review-only to avoid changing meaning or ownership aliases.

Ranked dictionary guesses must not singularize unfamiliar plurals. Spacing repairs are limited to gaps between prose letters, preserving indentation, diagram boundaries and tool directives.

Spacing alone is not a complete language repair. Require a dictionary-backed typo correction on the same line before publishing a spacing edit, and still recheck the result for residual findings. A clean library recheck cannot prove that repeated words, malformed quotes, numeric abbreviations or verb agreement are correct; withdraw unsupported spacing-only edits without claiming the baseline wording is fixed.

Repeated-word diagnostics wholly inside parsed prose remain review-only even beside masked inline code. Do not suppress them because the code mask introduces nearby whitespace, or inspect the masked code itself. The library may miss repetitions such as `Returns returns`; withdraw their spacing-only edits rather than claiming the repetition is repaired.

Regular inflections of recognized dictionary terms require explicit typo-dictionary evidence; ranked guesses remain review-only even when the inflected form is absent from the dictionary.

Unfamiliar capitalized terms require an explicit typo-dictionary correction; ranked edit-distance guesses remain review-only because they may be proper names.

Quoted examples that parse as code calls are nonprose; preserve their spelling and casing even when nearby prose uses the uppercase acronym.

Unquoted call notation with an identifier immediately followed by parentheses is also nonprose when it parses as a call. Preserve it while keeping spaced prose parentheses and nearby typos eligible.

Call examples with bare ellipsis arguments are also nonprose when their only parser diagnostics identify missing spread expressions.

Hyphenated word fragments are not standalone spelling or acronym candidates. Same-length ranked substitutions require explicit typo-dictionary evidence; otherwise they remain review-only to preserve technical meaning and references.

Colon-joined identifiers in command names are not standalone spelling or acronym candidates; a prose label followed by a colon and whitespace remains eligible.

Dot-prefixed extensions and member names are not standalone spelling or acronym candidates. Negated dictionary terms require explicit typo-dictionary evidence rather than ranked guesses.

Single-identifier block comments attached to parsed call or constructor arguments are labels, not prose. Preserve their exact spelling even when a typo dictionary suggests a replacement; nearby descriptive comments remain eligible.

Run `node --test bridge\test\spelling.test.mjs bridge\test\spelling-publication.test.mjs bridge\test\spelling-prepared-repair.test.mjs` from `C:\Code\spool-runners`. Standalone runners discover the existing native test fixture in an adjacent `spool-desktop` checkout automatically, while retaining the monorepo fallback. For other layouts, point `CARGO_TARGET_DIR` at the desktop's existing native target directory or set `SPOOL_CONTROL_TEST_BINARY` to its built native test executable. Explicit configuration takes precedence; do not build native tooling just to supply an already-built fixture. These isolated runner fixtures do not replace repository MCP build/check gates.

Regenerate the current owner's published batch with `node C:\Code\spool-runners\scanners\spelling\repair.mjs --repo <assigned-checkout> --journal <spool-root>\.runner\automation\runners\spelling\.runner\spelling-publications.json --owner <current-task-id> --spool-root <spool-root> --output <absolute-artifact-path>`; inspect the report, then repeat with `--apply`. This preserves code and metadata, restores unsafe generated edits to source, and holds ambiguous or incomplete corrections. An unverified changed head or dirty checkout remains a blocker, not permission to reset or hand-edit.

The shared repair path supports a canonical updater-prepared merge only when the original task, session, publication history, exact remote head, preparation, target and untouched Git merge/index snapshots agree. It preserves target deletions only for parser-verified prose-only changes within the published batch. Inspect `deletedFiles` and `mergeTarget` in the report; `--apply` resolves those deletions and regenerates survivors against that target without altering unrelated staged target changes. Stage the generated survivors, complete the prepared merge with normal Git commit hooks, and use canonical Bohemia build/check/publication. Validate the PR diff against the target, not the old HEAD's staged master changes. Never abort/reset the merge, resurrect target-deleted files, or manually replace prose. Newer checked original-owner publications are reconciled from verified evidence, never by editing the journal to suppress a mismatch.

A preserved unpublished merge is accepted only when its first-parent chain reaches the exact published head through target integrations alone, every other parent belongs to the prepared target history, its head matches the canonical handoff, and every integration's target-relative changes are batch-owned parser-verified prose or non-release metadata. Ordinary unpublished commits remain blocked even between otherwise valid merges. Content conflicts require exact original index stages and prose-only source changes; regeneration takes executable code from the current target, then applies the shared language engine. Inspect `resolvedFiles`; apply resolves and stages only those verified conflict paths, preserving all other prepared target changes. `publishedHead` remains the remote head; `workspaceHead` records the preserved local integration.

After verifying every completed integration, regeneration excludes batch files absent from its target baseline. It preserves committed target deletions and renames without admitting files resurrected by unpublished work.

Use the existing Bohemia validation and checked publication workflow for the prose diff only. Keep engine changes in spool-runners. Report engine fix, regression, regenerated files, unresolved holds and verified PR head; never call an unresolved language hold fixed or resolve its thread.

An operator holding the idle agent/workspace admission lock may pass `--recover <previous-applied-report>` before regeneration. Recovery requires the exact published owner, branch, head and complete generated file contents, rejects staged/untracked/unrelated or subsequent edits, and preserves the output in a named Git stash. It never discards authored work or resets the checkout.

For findings about introduced corruption, distinguish withdrawing the unsafe edit from repairing unrelated baseline prose. Verify each reported defect against the published head and regenerated output; do not treat every held baseline language suggestion as a failed restoration, or claim a remaining defect fixed.

Regeneration reports `hasChanges` and `remainingFiles` against the source baseline. If no corrections remain, report that the existing PR is obsolete; metadata alone is not a fix. Never create a replacement PR or claim a metadata-only PR contains corrections.
