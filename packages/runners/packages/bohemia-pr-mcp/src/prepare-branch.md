# Branch preparation

`operations.mjs` owns the workspace lock and delegates branch handling to
`prepare-branch.mjs`. All runners still use `bohemia_prepare`; there is no
reviewer-specific checkout or cleanup implementation.

Before branch preparation and after setup, unchanged Git entries are refreshed.
Windows generators can rewrite CRLF to LF and leave `git status` reporting a
modified file even though its canonical content matches the index exactly.
Refresh requires both an empty raw diff (without external diff or text conversion)
and an identical canonical blob hash. It refreshes that literal path with
`git add --renormalize`; source bytes and the staged tree remain unchanged.

Real content or whitespace edits, file-mode changes, staged changes and untracked
files remain protected by the existing dirty-checkout refusal.
When creating a different branch, an untouched canonical prepared merge can be
recovered without resetting the repository. Recovery requires its matching
successful preparation receipt, original HEAD and merge target, unchanged
`AUTO_MERGE` contents, and conflict index stages matching the original commits.
It preserves the preparation receipt, index and merge message under
`.git/bohemia-prepared-merges/`, and retains source, target and generated tree
objects through `refs/bohemia/prepared-merges/` before `git merge --abort`.
Authored resolutions, unknown/manual merges, other Git operations and ambiguous
merge bases are refused. Same-branch repairs keep the existing conflict-resume
path. The caller must still hold the runner's agent/workspace admission lock and
verify no active owner before and after canonical preparation.
No automatic reset, stash, clean or whitespace-ignoring comparison is used.
Exact-revision reviews still require the requested branch, commit and target
ancestry before the runner can hand work to an agent.

Run the focused regression suite with
`bun test --timeout 30000 src/prepare-branch.test.ts src/recover-prepared-merge.test.ts`.
