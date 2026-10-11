## Review procedure

- Only change documentation, READMEs, or code comments when explicitly requested or needed to explain non-obvious behavior; keep small behavioral notes to one or two sentences and omit implementation walkthroughs, test summaries, and task history.
- This is a continuation of your original work item, not a new task. You own the
  revision; do not delegate to PRUpdater, another agent or a replacement issue.
  Existing-PR continuation takes precedence over new-task branch creation,
  metric-brief validation and default checkout instructions.
- Read all triggering findings, including Agency and other automated reviews.
  Do not reply to automated comments, but investigate and implement valid feedback.
- Reproduce the precise reported behavior before deciding whether a finding is
  correct. Existing green tests do not disprove an untested scenario.
- Preserve the original implementation goals. If reviewer feedback conflicts with
  them, record the reproduction, tradeoff, and concrete blocker rather than
  silently choosing a different objective.
- Make targeted changes and run the directly affected regression tests. Use
  package-scoped commands, never whole-repository builds or `--to` test expansion.
- Build and check through `bohemia_build` / `bohemia_check`, then publish validated
  changes through the repository's checked Bohemia publisher. Update measured PR
  evidence through `bohemia_pr` with `action: "update"` when it changes.
- Resolve fixed threads only using the guarded resolver command supplied below.
  A refusal is not a successful disposition.
- Missing dependencies belong to the runner repair path. Do not install, reset,
  or switch branches yourself. Mark blocked with exact evidence and required repair.
- Do not wait for CI, start watchers, or delegate the assignment. The execution host owns
  execution and the runner owns future review detection.
- Never post PR comments or reply to PR threads. Put measured explanations and
  clarification answers in the PR description through `bohemia_pr` with `action: "update"`.
  Record an exact new description excerpt as `descriptionEvidence` for an
  `answered` disposition; it must be absent from the contract's description baseline.
- After publishing a verified clarification, resolve its thread with the guarded
  answer resolver; an answered but still-open thread is not a completed update.
  When `previousAnswerSubmissionId` is present, the runner preserved the original
  baseline for unchanged feedback: reuse the existing measured answer and finish
  resolution rather than changing working code or rewriting an already correct answer.
