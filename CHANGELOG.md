# Changelog

> **The entries before 2026-08-28 are missing, not absent.** All 1,034 lines of this file were
> removed by an undeclared deletion inside a docs-pointer commit, and no gate objected. ISS-872
> records the loss; ISS-880 owns restoring the record and making it unlosable. Do not read the short
> list below as the project's release history.

## [Unreleased]

### Added

- Work queued behind a paused pipeline run is now reported instead of sitting silently. Of every
  gate that can hold a `queued` job, `pipeline_run_not_running` was the only one with neither a
  reaper nor an alarm behind it: the picker only offers jobs whose run is `running`, so nothing
  behind a pause can start, and because the active-job index covers `queued`, nothing can queue a
  replacement step for that issue either — the issue is dead, not slow. Measured on the fleet
  2026-08-30, four triage jobs had been in that state for 38 days with no surface anywhere able to
  say so. A new sweeper pass notifies the project owner once per paused run past the threshold,
  naming what paused it, how many steps are frozen behind it, and — read from the pause kind, not
  guessed — whether it will resume by itself. The notification clears as soon as the run leaves
  `paused`, whether it resumed or was closed. Nothing is cancelled, re-queued or re-dispatched: a
  pause is either a machine condition that clears itself or a decision only a person can revisit,
  and a job killed here is work the resume existed to rescue. (ISS-879)

- A plan now records the branches that were weighed and dropped, not only the one that was taken.
  Forge keeps the issue rather than the conversation, so a rejected branch that is not in the plan is
  gone — and a plan without it reads exactly like one where nothing else was ever considered. Both
  plan-writing skills (the autonomous driver and the staged planner) ask for a `Rejected
  alternatives` section naming each branch and the fact that killed it, say that a forced choice is
  written as forced, and say that an empty heading is worse than none. What is checked is that the
  shipped bodies still ask; whether a given plan's rejected branches are real is prose no test can
  read. (ISS-883)

- `docs/VISION.md` and every proposal now say what adopting them costs the reader, and a gate keeps
  it that way. The constitution had a Boundaries section — what Forge will not become — and nothing
  pricing what choosing Forge takes from a team that chooses it, while the repo's own rule reads "a
  trade-off is priced or it is not taken". `check-honest-costs` refuses an absent section, one that
  prices nothing, and a `TBD` where the price goes; it cannot judge whether a stated price is honest,
  and says so. (ISS-882)

- Attention lists agent-filed `draft` issues that no human has looked at yet. `draft` is inert by
  design — the dispatcher never picks it up and nothing notifies on a draft create — so a proposal
  an agent filed used to be reachable from no surface in the product: measured 2026-08-30, 428 of
  them across 16 projects, all addressed to the account that paired the runner rather than to anyone
  who signs in. They now reach the project's admins, ordered by priority, capped at 20 rows with the
  real total shown; one human comment clears a row for good. (ISS-881)

### Fixed

- On an autonomous project, splitting an issue into children now works end to end, and a park
  always has a way out. Two paths could put an issue on a status no dispatcher reads and no
  person could wake, which is the state-never-lies principle breached in the one place nothing
  else watches. Decompose promoted its children to `approved`, a status the autonomous
  dispatcher never looks at — it reads `open` and nothing else — so the children sat untouched
  while the board rendered them as *running*; ten issues across two projects were frozen this
  way when the fix landed, one of them for eleven days. Separately, an agent asking a human a
  question could land the issue on `waiting`, which the comment-answer path deliberately never
  restarts, so the question could never be answered. Now the cascade targets whichever status
  that project's driver actually dispatches, a parent moved to `approved` by a human following
  an older guide is carried on rather than left there, the parent's own work is held until every
  child's code has merged, and an agent's `waiting` is rewritten at write time to the one park a
  comment does restart — after the guards run, so the reason it must give and the kind it must
  declare are still demanded and still posted. A person's own `waiting` is left alone, because
  their pause is theirs to end, and the parks already sitting there are now surfaced to a human
  instead of waiting unannounced. Staged projects are unchanged, deliberately: one project's
  driver must never change another's vocabulary. (ISS-886)

- A pipeline run under an issue that was DROPPED is now closed, and its queued steps with
  it. The backstop that closes runs whose issue has already finished matched only `closed`,
  while the set of statuses that close a run has been `{closed, dropped}` — so an issue
  abandoned rather than completed left its run open forever with its queued steps orphaned
  underneath, and nothing on any axis reaped them. `dropped` is one of the five statuses the
  autonomous driver may write, so this was reachable on every autonomous project. (ISS-879)

- Cancelling a pipeline run from the run view now announces itself. Cancel flipped the run
  and told the browser, but never emitted the lifecycle event three other things listen for,
  so an operator cancel silently skipped them: release-batch claims were left for a
  once-a-minute sweeper to find, the new frozen-queue notification was never cleared, and
  memory candidates were never mined from a cancelled issue run at all. (ISS-879)

- Clearing a notification is now a single locked statement instead of a read followed by a
  write. With one clearer per notification that pair was safe; the frozen-queue notification
  above is the first with two, and both could see the same row unread before either wrote,
  decrementing the reader's unread count twice for one notification. (ISS-879)

- `noProgressRounds` now reaches the mode the pipeline actually runs in. The knob had two readers and
  only one worked: the prompt printed it to every agent, while the alarm compared it to an issue's
  total reopen count — a number that moves only on a `reopen` transition, which autonomous mode never
  performs, because the driver holds the issue in progress from claim to close and the review loop is
  a phase re-entry. Measured 2026-08-30: of 19 runs that went five or more coding rounds inside ONE
  autonomous run, 18 had a reopen count of zero, and the one exception was alarming on reopens from
  its earlier staged life, days before the churn nobody was told about. A second pass counts the
  thing that does move — consecutive review rejections in one running run, with no approval in
  between — and notifies when it reaches the same number. It counts rejections the reviewer wrote,
  not the agent's own account of its progress, so an agent cannot decide whether it is churning; the
  agent's `churn` ledger stays as the human's reading material and is named as such. Rounds that each
  fix a different blocker still do not alarm, and one approval resets the count. Nothing is capped,
  parked or blocked — there is still no limit on how many rounds an issue may take. (ISS-878)
